import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./exec.js";
import { shrinkImage } from "./image.js";

// PDFs go through poppler: pdfinfo for the page count, pdftotext for the text, pdftoppm for a page
// image. All three write to files or pipes, so nothing here needs a native module.

export async function pdfPageCount(file) {
  const { stdout } = await run("pdfinfo", [file]);
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (match == null) throw new Error("pdfinfo did not report a page count");
  return Number(match[1]);
}

// pdfTextByPage extracts every page in one pass and splits on the form feed poppler emits.
export async function pdfTextByPage(file) {
  const { stdout } = await run("pdftotext", ["-layout", file, "-"]);
  const pages = stdout.split("\f");
  if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop();
  return pages;
}

export async function renderPdfPage(file, page, { maxEdge = 1600, dpi = 110 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-pdf-"));
  try {
    const prefix = path.join(dir, "page");
    await run("pdftoppm", ["-png", "-r", String(dpi), "-f", String(page), "-l", String(page), file, prefix]);
    const rendered = (await readdir(dir)).filter((name) => name.endsWith(".png")).sort();
    if (rendered.length === 0) throw new Error(`pdftoppm produced no image for page ${page}`);
    const buffer = await readFile(path.join(dir, rendered[0]));
    return await shrinkImage(buffer, "image/png", { maxEdge });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
