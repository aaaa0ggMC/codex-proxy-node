import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./exec.js";

// Decks and PDF pages routinely embed multi-megabyte images. Base64 inflates them by a third and
// the model pays for every pixel, so anything headed upstream is re-encoded small first.

const EXTENSION_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tif",
  "image/webp": "webp",
};

let knownEncoder = null;

async function encoder() {
  if (knownEncoder != null) return knownEncoder;
  for (const candidate of ["magick", "convert"]) {
    try {
      await run(candidate, ["-version"]);
      knownEncoder = candidate;
      return candidate;
    } catch {
      // try the next one
    }
  }
  knownEncoder = "";
  return "";
}

// shrinkImage returns a JPEG sized for a vision model. Without ImageMagick it degrades to the
// original bytes rather than failing the whole tool call.
export async function shrinkImage(buffer, mime, { maxEdge = 1600, quality = 82 } = {}) {
  const command = await encoder();
  if (command === "") return { mime, base64: buffer.toString("base64"), bytes: buffer.length };

  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-img-"));
  try {
    const source = path.join(dir, `in.${EXTENSION_BY_MIME[mime] ?? "png"}`);
    const target = path.join(dir, "out.jpg");
    await writeFile(source, buffer);
    await run(command, [source, "-resize", `${maxEdge}x${maxEdge}>`, "-quality", String(quality), target]);
    const data = await readFile(target);
    return { mime: "image/jpeg", base64: data.toString("base64"), bytes: data.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
