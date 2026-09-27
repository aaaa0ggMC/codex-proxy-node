import { inflateRawSync } from "node:zlib";

// A minimal ZIP reader, enough for OOXML (pptx/xlsx/docx) and other deflate-based containers.
// Only the central directory and the entries it points at are read, so a large archive costs one
// pass over the file plus whatever is extracted. ZIP64 is not supported; OOXML files that need it
// are far beyond anything a chat attachment should be, and a clear error beats a wrong answer.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - (0xffff + 22));
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("not a zip archive: end of central directory not found");
}

export function readZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  const entries = new Map();
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error("corrupt zip: bad central directory entry");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`zip64 archives are not supported (entry ${name})`);
    }
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const entry = entries.get(name);
      if (entry == null) return null;
      if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
        throw new Error(`corrupt zip: bad local header for ${name}`);
      }
      const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
      const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
      const start = entry.localOffset + 30 + nameLength + extraLength;
      const raw = buffer.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) return Buffer.from(raw);
      if (entry.method === 8) return inflateRawSync(raw);
      throw new Error(`unsupported zip compression method ${entry.method} for ${name}`);
    },
    readText(name) {
      const data = this.read(name);
      return data == null ? null : data.toString("utf8");
    },
  };
}

// resolveZipPath joins a relative relationship target onto an archive folder, collapsing "..".
export function resolveZipPath(baseDir, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}
