import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { run } from "./exec.js";
import { officeConverterEnabled } from "./settings.js";
import { shrinkImage } from "./image.js";

// LibreOffice, compiled to WebAssembly, renders the office formats that have no other faithful
// renderer on this device (.docx, .xlsx) and gives a truer layout for .pptx than a hand-rolled
// renderer can. It is heavy — one cold conversion is around a minute and a few hundred MB — so it
// runs once per document, through the package's subprocess path, and only the resulting PDF is kept;
// pages are then rasterised by poppler, which is fast.

const require = createRequire(import.meta.url);

let modulePromise = null;
function converterModule() {
  if (modulePromise == null) {
    modulePromise = import("@matbee/libreoffice-converter/server").then((mod) => mod).catch(() => false);
  }
  return modulePromise;
}

function wasmDir() {
  try {
    return path.join(path.dirname(require.resolve("@matbee/libreoffice-converter/package.json")), "wasm");
  } catch {
    return "";
  }
}

export async function officeAvailable() {
  return (await converterModule()) !== false;
}

// officeToPdf converts a .docx/.xlsx/.pptx buffer to a PDF, or returns null when the converter is
// unavailable or the file cannot be read. onProgress gets a human string before the long wait.
export async function officeToPdf(buffer, { onProgress } = {}) {
  if (!officeConverterEnabled()) return null;
  const mod = await converterModule();
  if (mod === false) return null;
  onProgress?.("LibreOffice: converting to PDF (this can take up to a minute)");
  const options = wasmDir() === "" ? undefined : { wasmPath: wasmDir() };
  try {
    const result = await withTimeout(mod.convertDocument(buffer, { outputFormat: "pdf" }, options), OFFICE_TIMEOUT_MS);
    return result?.data == null ? null : Buffer.from(result.data);
  } catch {
    return null;
  }
}

// A conversion that overruns is abandoned (the subprocess finishes on its own); the caller falls
// back to the plain-text view rather than leaving the tool to time out. Kept under the docs tools
// own 120s timeout so a slow deck degrades to text instead of failing the call.
const OFFICE_TIMEOUT_MS = Number(process.env.CODEX_PROXY_OFFICE_TIMEOUT_MS) || 180_000;

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LibreOffice conversion exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withPdfFile(pdfBuffer, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-office-"));
  try {
    const file = path.join(dir, "document.pdf");
    await writeFile(file, pdfBuffer);
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function pdfBufferPages(pdfBuffer) {
  return withPdfFile(pdfBuffer, async (file) => {
    try {
      const { stdout } = await run("pdfinfo", [file]);
      const match = stdout.match(/^Pages:\s+(\d+)/m);
      return match == null ? 0 : Number(match[1]);
    } catch {
      return 0;
    }
  });
}

export async function pdfBufferText(pdfBuffer) {
  return withPdfFile(pdfBuffer, async (file) => {
    try {
      const { stdout } = await run("pdftotext", ["-layout", file, "-"]);
      const pages = stdout.split("\f");
      if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop();
      return pages;
    } catch {
      return [];
    }
  });
}

export async function renderPdfBufferPage(pdfBuffer, page, { maxEdge, dpi = 110 } = {}) {
  return withPdfFile(pdfBuffer, async (file) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-office-png-"));
    try {
      const prefix = path.join(dir, "page");
      await run("pdftoppm", ["-png", "-r", String(dpi), "-f", String(page), "-l", String(page), file, prefix]);
      const rendered = (await readdir(dir)).filter((name) => name.endsWith(".png")).sort();
      if (rendered.length === 0) return null;
      return await shrinkImage(await readFile(path.join(dir, rendered[0])), "image/png", { maxEdge });
    } catch {
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
