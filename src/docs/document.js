import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { stableId } from "../util.js";
import { shrinkImage } from "./image.js";
import { pdfPageCount, pdfTextByPage, renderPdfPage } from "./pdf.js";
import { parseDocx } from "./docx.js";
import { IMAGE_EXTENSIONS, TEXT_EXTENSIONS, parseXlsx } from "./sheet.js";
import { parsePptx, rasteriseSvg, renderDeckSvgs, renderSlideImage } from "./pptx.js";
import { officeToPdf, pdfBufferPages, pdfBufferText, renderPdfBufferPage } from "./office.js";
import { imageMaxEdge } from "./settings.js";

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

export async function openDocument(file, options = {}) {
  const info = await stat(file);
  return loadDocument({
    id: await documentId(file),
    file,
    name: path.basename(file),
    extension: path.extname(file).toLowerCase(),
    bytes: info.size,
  }, options);
}

async function loadDocument({ id, file, name, extension, bytes }, { onProgress } = {}) {

  if (extension === ".pptx") {
    const bytes = await readFileBytes(file);
    const deck = parsePptx(bytes);
    // A slide is laid out only when the model actually asks for it (pptx-glimpse is addressed one
    // slide at a time); the result is remembered, so a second read of the same slide is free.
    const svgCache = new Map();
    let printPdf;
    const slideSvg = async (page) => {
      if (!svgCache.has(page)) {
        const rendered = await renderDeckSvgs(bytes, [page]);
        svgCache.set(page, rendered == null ? null : rendered[0] ?? null);
      }
      return svgCache.get(page);
    };
    return {
      id,
      name,
      kind: "pptx",
      bytes,
      pageCount: deck.slides.length,
      pageLabel: "slide",
      imageSupport: true,
      // Slide body only. Speaker notes are a separate field on purpose: mixing them into the
      // page text made a deck read like a transcript of the presenter view.
      text: async (page) => (deck.slides[page - 1]?.text ?? "").trim(),
      notes: async (page) => (deck.slides[page - 1]?.notes ?? "").trim(),
      images: async (page, { render, onProgress: progress } = {}) => {
        const slide = deck.slides[page - 1];
        if (slide == null) return [];
        // render: true is the explicit "print this slide with LibreOffice" request — the truest
        // layout, paying a one-off conversion. The default is the fast pptx-glimpse slide.
        if (render === true) {
          if (printPdf === undefined) printPdf = await officeToPdf(bytes, { onProgress: progress });
          if (printPdf != null) {
            const printed = await renderPdfBufferPage(printPdf, page, { maxEdge: imageMaxEdge(), dpi: PRINT_DPI });
            if (printed != null) return [printed];
          }
        }
        // pptx-glimpse lays the slide out properly; the hand-rolled renderer and the embedded
        // pictures are fallbacks. LibreOffice is reserved for the formats that need it (.docx/.xlsx).
        const svg = await slideSvg(page);
        if (svg != null) {
          const rendered = await rasteriseSvg(svg, { maxEdge: imageMaxEdge() });
          if (rendered != null) return [rendered];
        }
        // Fallbacks: the hand-rolled renderer, then the pictures the slide embeds.
        const rendered = await renderSlideImage(slide, deck.size, { maxEdge: imageMaxEdge() });
        if (rendered != null) return [rendered];
        const out = [];
        for (const image of slide.images) out.push(await shrinkImage(image.data, image.mime));
        return out;
      },
    };
  }

  // Plain text, tables and code: there is nothing to render and nothing to paginate, so the file
  // is one section of its own bytes.
  if (TEXT_EXTENSIONS.includes(extension)) {
    const body = await readFileBytes(file);
    return {
      id,
      name,
      kind: extension.slice(1),
      bytes,
      pageCount: 1,
      pageLabel: "section",
      imageSupport: false,
      text: async () => body.toString("utf8"),
      notes: async () => "",
      images: async () => [],
    };
  }

  if (extension === ".xlsx") {
    const bytes = await readFileBytes(file);
    const parsed = parseXlsx(bytes);
    const printed = printedPages(bytes);
    return {
      id,
      name,
      kind: "xlsx",
      bytes,
      pageCount: parsed.sheets.length,
      pageLabel: "sheet",
      imageSupport: true,
      text: async (page) => {
        const sheet = parsed.sheets[page - 1];
        if (sheet == null) return "";
        return `# ${sheet.name}\n${sheet.csv}`;
      },
      notes: async () => "",
      // A sheet is read as text; the printed page is only produced when it is explicitly asked for.
      images: async (_page, { render, onProgress } = {}) => (render === true ? printed(onProgress) : []),
    };
  }

  // An image file has no text and no pages: it is one section whose only content is the picture.
  if (IMAGE_EXTENSIONS.includes(extension)) {
    const body = await readFileBytes(file);
    const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
    return {
      id,
      name,
      kind: "image",
      bytes,
      pageCount: 1,
      pageLabel: "image",
      imageSupport: true,
      text: async () => "",
      notes: async () => "",
      images: async () => [await shrinkImage(body, mime)],
    };
  }

  if (extension === ".docx") {
    const bytes = await readFileBytes(file);
    const parsed = parseDocx(bytes);
    const printed = printedPages(bytes);
    return {
      id,
      name,
      kind: "docx",
      bytes,
      // Word does not paginate in the file, so there is one section rather than invented pages.
      pageCount: 1,
      pageLabel: "section",
      imageSupport: true,
      text: async () => parsed.text,
      notes: async () => "",
      // Reading a Word file is its text plus the pictures it embeds. `render: true` is the explicit
      // "print the whole document" path, which needs LibreOffice and is slow.
      images: async (_page, { render, onProgress } = {}) => {
        if (render === true) {
          const pages = await printed(onProgress);
          if (pages.length > 0) return pages;
          // The print failed (LibreOffice timed out or could not read the file); the pictures the
          // document embeds are still something to look at.
        }
        // A long illustrated document can embed hundreds of pictures; returning all of them costs
        // minutes of encoding and floods the context, so only the first few are handed over.
        return Promise.all(parsed.images.slice(0, MAX_EMBEDDED_IMAGES).map((image) => shrinkImage(image.data, image.mime)));
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
      imageSupport: true,
      text: async (page) => (pages[page - 1] ?? "").trim(),
      notes: async () => "",
      images: async (page) => [await renderPdfPage(file, page)],
    };
  }

  throw new Error(
    `unsupported document type ${JSON.stringify(extension)}; this proxy reads .pdf, .pptx, .docx, .xlsx and text files`,
  );
}

// The "print it" path shared by the office formats: convert the file with LibreOffice once, then
// rasterise every page. The PDF is remembered, so a second print is just the raster step.
function printedPages(bytes) {
  let pdf;
  return async (onProgress) => {
    if (pdf === undefined) pdf = await officeToPdf(bytes, { onProgress });
    if (pdf == null) return [];
    const count = Math.max(1, await pdfBufferPages(pdf));
    const out = [];
    for (let page = 1; page <= count; page++) {
      const image = await renderPdfBufferPage(pdf, page, { maxEdge: imageMaxEdge(), dpi: PRINT_DPI });
      if (image != null) out.push(image);
    }
    return out;
  };
}

// How many of a document own pictures a single read returns (see the .docx branch).
const MAX_EMBEDDED_IMAGES = 8;

// Printing a page is for a look at the layout, not for pixel fidelity, so it is rendered at a
// screen dpi and the shared ceiling does the rest.
const PRINT_DPI = 96;

async function readFileBytes(file) {
  const { readFile } = await import("node:fs/promises");
  return readFile(file);
}

// The outline lists every page's text in full: deciding how much of it to use is the model's call,
// not ours. Only the page count is capped, and the cap is stated rather than applied silently, so
// nothing looks like it ended early.
export async function outlineOf(document, { maxPages = 40, readTool = "" } = {}) {
  const lines = [`${document.name} (${document.kind}, ${document.pageCount} ${document.pageLabel}s, ${(document.bytes / 1024).toFixed(0)}KB)`];
  const shown = Math.min(document.pageCount, maxPages);
  for (let page = 1; page <= shown; page++) {
    const text = (await document.text(page)).replace(/[ \t]+/g, " ").trim();
    lines.push(`${page}. ${text || "(no text)"}`);
  }
  if (document.pageCount > shown) {
    // The tool that reads the rest is named by the caller (the docs plugin), which owns the tool and
    // its wire name; this module never hardcodes one.
    const hint = readTool === "" ? "" : `; call ${readTool} for those`;
    lines.push(`… ${document.pageCount - shown} more ${document.pageLabel}s not listed${hint}`);
  }
  return lines.join("\n");
}
