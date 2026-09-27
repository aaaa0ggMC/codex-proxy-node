import { stat } from "node:fs/promises";
import path from "node:path";
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

export async function openDocument(file) {
  const name = path.basename(file);
  const extension = path.extname(file).toLowerCase();
  const bytes = (await stat(file)).size;
  const id = await documentId(file);

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
