import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { stableId } from "../util.js";
import { shrinkImage } from "./image.js";
import { pdfPageCount, pdfTextByPage, renderPdfPage } from "./pdf.js";
import { parsePptx } from "./pptx.js";

// A document exposes the same four things whether it came from a deck or a PDF: a page count, the
// text of a page, the images of a page, and a text search. That is the "text and images together"
// model the tools hand to the model.

export function searchPages(pages, query, limit = 8) {
  const needle = query.toLowerCase().trim();
  if (needle === "") return [];
  const hits = [];
  for (const [index, text] of pages.entries()) {
    if (hits.length >= limit) break;
    const haystack = text.toLowerCase();
    let from = haystack.indexOf(needle);
    if (from === -1) continue;
    const snippets = [];
    while (from !== -1 && snippets.length < 3) {
      const start = Math.max(0, from - 60);
      snippets.push(text.slice(start, Math.min(text.length, from + needle.length + 90)).replace(/\s+/g, " ").trim());
      from = haystack.indexOf(needle, from + needle.length);
      if (snippets.length >= 1 && limit <= 1) break;
    }
    hits.push({ page: index + 1, snippets });
  }
  return hits;
}

// A deterministic id keeps the prompt stable across requests: the same file must produce the same
// document id, or the prefix cache misses on every turn.
export async function documentId(file) {
  const info = await stat(file);
  return stableId("doc", path.resolve(file), String(info.size), String(Math.round(info.mtimeMs)));
}

// An attachment arrives as bytes, not a path, and the client re-sends it on every turn. The id is
// therefore derived from the content and the bytes are parked at a path derived from the same hash,
// so the same attachment always produces the same document id and the prompt prefix never shifts.
export async function openDocumentFromBuffer(filename, buffer) {
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const extension = path.extname(filename).toLowerCase();
  const dir = path.join(tmpdir(), "codex-proxy-docs");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${hash}${extension}`);
  try {
    await stat(file);
  } catch {
    await writeFile(file, buffer, { mode: 0o600 });
  }
  return loadDocument({ id: `doc_${hash}`, file, name: path.basename(filename), extension, bytes: buffer.length });
}

export async function openDocument(file) {
  const info = await stat(file);
  return loadDocument({
    id: await documentId(file),
    file,
    name: path.basename(file),
    extension: path.extname(file).toLowerCase(),
    bytes: info.size,
  });
}

async function loadDocument({ id, file, name, extension, bytes }) {

  if (extension === ".pptx") {
    const deck = parsePptx(await readFileBytes(file));
    return {
      id,
      name,
      kind: "pptx",
      bytes,
      pageCount: deck.slides.length,
      pageLabel: "slide",
      text: async (page) => withNotes(deck.slides[page - 1]),
      images: async (page) => {
        const slide = deck.slides[page - 1];
        const out = [];
        for (const image of slide.images) out.push(await shrinkImage(image.data, image.mime));
        return out;
      },
    };
  }

  if (extension === ".pdf") {
    const count = await pdfPageCount(file);
    const pages = await pdfTextByPage(file);
    return {
      id,
      name,
      kind: "pdf",
      bytes,
      pageCount: count,
      pageLabel: "page",
      text: async (page) => (pages[page - 1] ?? "").trim(),
      images: async (page) => [await renderPdfPage(file, page)],
    };
  }

  throw new Error(`unsupported document type ${JSON.stringify(extension)}; this proxy reads .pdf and .pptx`);
}

function withNotes(slide) {
  const text = slide?.text ?? "";
  if (slide?.notes) return `${text}\n\n[notes] ${slide.notes}`;
  return text;
}

async function readFileBytes(file) {
  const { readFile } = await import("node:fs/promises");
  return readFile(file);
}

export async function outlineOf(document, { width = 100, maxPages = 40 } = {}) {
  const lines = [`${document.name} (${document.kind}, ${document.pageCount} ${document.pageLabel}s, ${(document.bytes / 1024).toFixed(0)}KB)`];
  for (let page = 1; page <= Math.min(document.pageCount, maxPages); page++) {
    const text = (await document.text(page)).replace(/\s+/g, " ").trim();
    lines.push(`${page}. ${text.slice(0, width) || "(no text)"}`);
  }
  if (document.pageCount > maxPages) lines.push(`… ${document.pageCount - maxPages} more`);
  return lines.join("\n");
}
