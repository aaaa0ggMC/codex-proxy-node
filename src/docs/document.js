import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { stableId } from "../util.js";
import { shrinkImage } from "./image.js";
import { pdfPageCount, pdfTextByPage, renderPdfPage } from "./pdf.js";
import { parseDocx } from "./docx.js";
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
      // Slide body only. Speaker notes are a separate field on purpose: mixing them into the
      // page text made a deck read like a transcript of the presenter view.
      text: async (page) => (deck.slides[page - 1]?.text ?? "").trim(),
      notes: async (page) => (deck.slides[page - 1]?.notes ?? "").trim(),
      images: async (page) => {
        const slide = deck.slides[page - 1];
        const out = [];
        for (const image of slide.images) out.push(await shrinkImage(image.data, image.mime));
        return out;
      },
    };
  }

  if (extension === ".docx") {
    const parsed = parseDocx(await readFileBytes(file));
    return {
      id,
      name,
      kind: "docx",
      bytes,
      // Word does not paginate in the file, so there is one section rather than invented pages.
      pageCount: 1,
      pageLabel: "section",
      text: async () => parsed.text,
      notes: async () => "",
      images: async () => Promise.all(parsed.images.map((image) => shrinkImage(image.data, image.mime))),
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
      notes: async () => "",
      images: async (page) => [await renderPdfPage(file, page)],
    };
  }

  throw new Error(`unsupported document type ${JSON.stringify(extension)}; this proxy reads .pdf, .pptx and .docx`);
}

async function readFileBytes(file) {
  const { readFile } = await import("node:fs/promises");
  return readFile(file);
}

// The outline lists every page's text in full: deciding how much of it to use is the model's call,
// not ours. Only the page count is capped, and the cap is stated rather than applied silently, so
// nothing looks like it ended early.
export async function outlineOf(document, { maxPages = 40 } = {}) {
  const lines = [`${document.name} (${document.kind}, ${document.pageCount} ${document.pageLabel}s, ${(document.bytes / 1024).toFixed(0)}KB)`];
  const shown = Math.min(document.pageCount, maxPages);
  for (let page = 1; page <= shown; page++) {
    const text = (await document.text(page)).replace(/[ \t]+/g, " ").trim();
    lines.push(`${page}. ${text || "(no text)"}`);
  }
  if (document.pageCount > shown) {
    lines.push(
      `… ${document.pageCount - shown} more ${document.pageLabel}s not listed; call docs__read_page for those`,
    );
  }
  return lines.join("\n");
}
