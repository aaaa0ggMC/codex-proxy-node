import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./exec.js";
import { shrinkImage } from "./image.js";
import { imageMaxEdge } from "./settings.js";
import { readZip, resolveZipPath } from "./zip.js";

// PPTX is a zip of XML, and there is no LibreOffice on this device, so a slide is rendered here
// rather than converted: the shapes, text and pictures of the slide are turned into an SVG, and
// rsvg-convert rasterises it. Fidelity is a subset (no SmartArt, charts, gradients or group
// transforms), but the model gets the actual slide — layout, text and pictures together — instead
// of a pile of detached media files. The text extraction is kept too: it is what makes the deck
// searchable.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const EMU_PER_POINT = 12700;
const DEFAULT_SIZE = { cx: 12192000, cy: 6858000 };

export function unescapeXml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? match;
  });
}

function attributesOf(tag) {
  const out = {};
  for (const match of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g)) out[match[1]] = unescapeXml(match[2]);
  return out;
}

export function parseRelationships(xml) {
  if (xml == null) return [];
  const out = [];
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const attrs = attributesOf(match[0]);
    if (attrs.Id) out.push({ id: attrs.Id, type: attrs.Type ?? "", target: attrs.Target ?? "" });
  }
  return out;
}

export function shapeText(xml) {
  if (xml == null) return "";
  const paragraphs = [];
  for (const paragraph of xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    let text = "";
    for (const token of paragraph[1].matchAll(/<a:br\s*\/>|<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)) {
      text += token[1] === undefined ? "\n" : unescapeXml(token[1]);
    }
    if (text.trim() !== "") paragraphs.push(text.trim());
  }
  return paragraphs.join("\n");
}

const MIME_BY_EXTENSION = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp",
  tif: "image/tiff", tiff: "image/tiff", emf: "image/emf", wmf: "image/wmf", svg: "image/svg+xml", webp: "image/webp",
};

export function mimeForName(name) {
  return MIME_BY_EXTENSION[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
}

function slideOrder(zip) {
  const presentation = zip.readText("ppt/presentation.xml");
  const rels = parseRelationships(zip.readText("ppt/_rels/presentation.xml.rels"));
  const byId = new Map(rels.map((rel) => [rel.id, rel.target]));
  const ordered = [];
  for (const match of (presentation ?? "").matchAll(/<p:sldId\b[^>]*>/g)) {
    const target = byId.get(attributesOf(match[0])["r:id"]);
    if (target) ordered.push(resolveZipPath("ppt", target));
  }
  if (ordered.length > 0) return ordered;
  return zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
}

function slideSize(zip) {
  const presentation = zip.readText("ppt/presentation.xml") ?? "";
  const tag = /<p:sldSz\b[^>]*>/.exec(presentation)?.[0];
  if (tag == null) return DEFAULT_SIZE;
  const attrs = attributesOf(tag);
  const cx = Number(attrs.cx);
  const cy = Number(attrs.cy);
  return cx > 0 && cy > 0 ? { cx, cy } : DEFAULT_SIZE;
}

export function parsePptx(buffer) {
  const zip = readZip(buffer);
  const size = slideSize(zip);
  const slides = [];

  for (const [position, slidePath] of slideOrder(zip).entries()) {
    const xml = zip.readText(slidePath);
    if (xml == null) continue;
    const relsPath = `${slidePath.slice(0, slidePath.lastIndexOf("/"))}/_rels/${slidePath.slice(slidePath.lastIndexOf("/") + 1)}.rels`;
    const rels = parseRelationships(zip.readText(relsPath));
    const baseDir = slidePath.slice(0, slidePath.lastIndexOf("/"));

    const embed = new Map();
    const images = [];
    for (const rel of rels) {
      if (!rel.type.endsWith("/image")) continue;
      const path2 = resolveZipPath(baseDir, rel.target);
      const data = zip.read(path2);
      if (data == null) continue;
      const mime = mimeForName(path2);
      embed.set(rel.id, { mime, data });
      images.push({ path: path2, mime, data, bytes: data.length });
    }

    let notes = "";
    for (const rel of rels) {
      if (!rel.type.endsWith("/notesSlide")) continue;
      notes = shapeText(zip.readText(resolveZipPath(baseDir, rel.target)));
    }

    slides.push({ number: position + 1, path: slidePath, title: shapeText(xml).split("\n")[0] ?? "", text: shapeText(xml), notes, images, xml, embed });
  }

  return { kind: "pptx", size, slides };
}

// --- slide rendering -------------------------------------------------------------------------

const r = (value) => (Math.round(value * 100) / 100).toString();
const emu = (value) => (Number(value) || 0) / EMU_PER_POINT;

function attr(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag ?? "");
  return match == null ? "" : unescapeXml(match[1]);
}

function xfrm(raw) {
  const block = /<a:xfrm\b[\s\S]*?<\/a:xfrm>/.exec(raw ?? "")?.[0] ?? "";
  const off = /<a:off\b[^>]*>/.exec(block)?.[0] ?? "";
  const ext = /<a:ext\b[^>]*>/.exec(block)?.[0] ?? "";
  return { x: emu(attr(off, "x")), y: emu(attr(off, "y")), w: emu(attr(ext, "cx")), h: emu(attr(ext, "cy")) };
}

const SCHEME = { tx1: "#1a1a1a", tx2: "#404040", bg1: "#ffffff", bg2: "#f2f2f2", accent1: "#4472c4", accent2: "#ed7d31", accent3: "#a5a5a5", accent4: "#ffc000", accent5: "#5b9bd5", accent6: "#70ad47" };

function colorIn(raw) {
  const srgb = /<a:srgbClr\b[^>]*val="([0-9a-fA-F]{6})"/.exec(raw ?? "");
  if (srgb != null) return `#${srgb[1].toLowerCase()}`;
  const scheme = /<a:schemeClr\b[^>]*val="([^"]+)"/.exec(raw ?? "");
  if (scheme != null) return SCHEME[scheme[1]] ?? "#1a1a1a";
  return null;
}

function fillOf(raw) {
  if (/<a:noFill\b/.test(raw ?? "")) return "none";
  const block = /<a:solidFill>[\s\S]*?<\/a:solidFill>/.exec(raw ?? "")?.[0];
  return block == null ? null : colorIn(block);
}

function strokeOf(raw) {
  const ln = /<a:ln\b[^>]*>([\s\S]*?)<\/a:ln>/.exec(raw ?? "");
  if (ln == null) return null;
  if (/<a:noFill\b/.test(ln[1])) return null;
  const color = colorIn(ln[1]);
  if (color == null) return null;
  const width = emu(attr(ln[0], "w") || "9525");
  return { color, width: Math.max(0.5, width) };
}

function escapeText(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textOf(raw) {
  const body = /<p:txBody\b[\s\S]*?<\/p:txBody>/.exec(raw ?? "")?.[0] ?? "";
  const paragraphs = [];
  for (const paragraph of body.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const runs = [];
    for (const run of paragraph[1].matchAll(/<a:r\b[^>]*>([\s\S]*?)<\/a:r>/g)) {
      const text = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/.exec(run[1])?.[1];
      if (text == null) continue;
      const rPr = /<a:rPr\b[^>]*>/.exec(run[1])?.[0] ?? "";
      runs.push({
        text: unescapeXml(text),
        size: Math.max(6, (Number(attr(rPr, "sz")) || 1800) / 100),
        bold: attr(rPr, "b") === "1",
        color: colorIn(run[1]) ?? "#1a1a1a",
      });
    }
    const pPr = /<a:pPr\b[^>]*>/.exec(paragraph[1])?.[0] ?? "";
    if (runs.length > 0 && runs.some((run) => run.text.trim() !== "")) paragraphs.push({ runs, align: attr(pPr, "algn") || "l" });
  }
  return paragraphs;
}

function charWidth(character, size) {
  return (character.codePointAt(0) > 0x2e80 ? 1.0 : 0.55) * size;
}

function wrapText(text, width, size) {
  const lines = [];
  let line = "";
  let used = 0;
  for (const character of text.replace(/\r/g, "")) {
    if (character === "\n") {
      lines.push(line);
      line = "";
      used = 0;
      continue;
    }
    const advance = charWidth(character, size);
    if (used + advance > width && line !== "") {
      lines.push(line);
      line = "";
      used = 0;
    }
    line += character;
    used += advance;
  }
  lines.push(line);
  return lines;
}

function renderText(paragraphs, box) {
  const out = [];
  let y = box.y + 2;
  for (const paragraph of paragraphs) {
    for (const run of paragraph.runs) {
      const lineHeight = run.size * 1.28;
      const maxWidth = Math.max(run.size, box.w - 2);
      for (const line of wrapText(run.text, maxWidth, run.size)) {
        y += lineHeight;
        if (y > box.y + box.h + lineHeight) break;
        const anchor = paragraph.align === "ctr" ? "middle" : paragraph.align === "r" ? "end" : "start";
        const x = anchor === "middle" ? box.x + box.w / 2 : anchor === "end" ? box.x + box.w : box.x;
        out.push(`<text x="${r(x)}" y="${r(y)}" font-family="sans-serif" font-size="${r(run.size)}" font-weight="${run.bold ? "bold" : "normal"}" fill="${run.color}" text-anchor="${anchor}">${escapeText(line)}</text>`);
      }
    }
    y += 2;
  }
  return out;
}

function collect(xml) {
  const out = [];
  const re = /<(p:(?:sp|pic|cxnSp))\b[^>]*>([\s\S]*?)<\/\1>/g;
  let match;
  while ((match = re.exec(xml)) != null) out.push({ name: match[1], raw: match[0], inner: match[2], at: match.index });
  return out.sort((a, b) => a.at - b.at);
}

function renderPicture(node, embed) {
  const box = xfrm(node.raw);
  if (box.w <= 0 || box.h <= 0) return [];
  const rid = attr(/<a:blip\b[^>]*>/.exec(node.raw)?.[0] ?? "", "r:embed");
  const image = embed.get(rid);
  if (image == null) return [];
  return [`<image x="${r(box.x)}" y="${r(box.y)}" width="${r(box.w)}" height="${r(box.h)}" preserveAspectRatio="none" xlink:href="data:${image.mime};base64,${image.data.toString("base64")}"/>`];
}

function renderShape(node) {
  const box = xfrm(node.raw);
  const out = [];
  const fill = fillOf(node.raw);
  const stroke = strokeOf(node.raw);
  const prst = /<a:prstGeom\b[^>]*prst="([^"]+)"/.exec(node.raw)?.[1] ?? "rect";
  if (box.w > 0 && box.h > 0 && fill != null && fill !== "none") {
    const paint = `fill="${fill}"${stroke == null ? "" : ` stroke="${stroke.color}" stroke-width="${r(stroke.width)}"`}`;
    if (/ellipse|oval/i.test(prst)) out.push(`<ellipse cx="${r(box.x + box.w / 2)}" cy="${r(box.y + box.h / 2)}" rx="${r(box.w / 2)}" ry="${r(box.h / 2)}" ${paint}/>`);
    else out.push(`<rect x="${r(box.x)}" y="${r(box.y)}" width="${r(box.w)}" height="${r(box.h)}"${/round/i.test(prst) ? ' rx="8"' : ""} ${paint}/>`);
  }
  out.push(...renderText(textOf(node.raw), box));
  return out;
}

function renderConnector(node) {
  const box = xfrm(node.raw);
  const stroke = strokeOf(node.raw) ?? { color: "#404040", width: 0.5 };
  return [`<line x1="${r(box.x)}" y1="${r(box.y)}" x2="${r(box.x + box.w)}" y2="${r(box.y + box.h)}" stroke="${stroke.color}" stroke-width="${r(stroke.width)}"/>`];
}

export function slideToSvg(slide, size = DEFAULT_SIZE) {
  const width = size.cx / EMU_PER_POINT;
  const height = size.cy / EMU_PER_POINT;
  const background = fillOf(/<p:bg>[\s\S]*?<\/p:bg>/.exec(slide.xml)?.[0] ?? "") ?? "#ffffff";
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${r(width)}" height="${r(height)}" viewBox="0 0 ${r(width)} ${r(height)}">`];
  out.push(`<rect x="0" y="0" width="${r(width)}" height="${r(height)}" fill="${background === "none" ? "#ffffff" : background}"/>`);
  for (const node of collect(slide.xml)) {
    if (node.name === "p:pic") out.push(...renderPicture(node, slide.embed));
    else if (node.name === "p:cxnSp") out.push(...renderConnector(node));
    else out.push(...renderShape(node));
  }
  out.push("</svg>");
  return out.join("\n");
}

// renderSlideImage rasterises the slide SVG and shrinks it for the model. Returns null when the
// rasteriser is missing, so the caller can fall back to the embedded pictures.
export async function renderSlideImage(slide, size, { maxEdge = imageMaxEdge(), dpi = 110 } = {}) {
  const svg = slideToSvg(slide, size);
  const width = Math.round((size.cx / EMU_PER_POINT) * (dpi / 72));
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-pptx-"));
  try {
    const svgPath = path.join(dir, "slide.svg");
    const pngPath = path.join(dir, "slide.png");
    await writeFile(svgPath, svg);
    await run("rsvg-convert", ["-w", String(width), "-o", pngPath, svgPath]);
    return await shrinkImage(await readFile(pngPath), "image/png", { maxEdge });
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- pptx-glimpse: the real layout engine ----------------------------------------------------
//
// The hand-rolled renderer above is a fallback. pptx-glimpse parses the OOXML properly (theme,
// layouts, masters, grouped shapes, text metrics via opentype.js) and emits one SVG per slide with
// the text already converted to paths, so rasterising needs no fonts in the SVG viewer. Its
// dependencies are pure JS/WASM, so it installs on this device.

// pptx-glimpse only needs a font to MEASURE text; the SVG keeps the deck family names and
// rsvg-convert draws the glyphs through fontconfig. Scanning every system font cost ~16s on this
// device, so a single Latin face is handed over instead and the scan is skipped.
const MEASURE_FONTS = [path.join(process.env.PREFIX ?? "/data/data/com.termux/files/usr", "share/fonts/TTF/DejaVuSans.ttf")];

let measureFontsPromise = null;
function measureFonts() {
  if (measureFontsPromise == null) {
    measureFontsPromise = (async () => {
      const fonts = [];
      for (const file of MEASURE_FONTS) {
        try {
          fonts.push({ name: "DejaVu Sans", data: await readFile(file) });
        } catch {
          // a missing measure font just means the library falls back to its own metrics
        }
      }
      return fonts;
    })();
  }
  return measureFontsPromise;
}

let glimpsePromise = null;
function glimpse() {
  if (glimpsePromise == null) {
    glimpsePromise = import("pptx-glimpse").then((mod) => mod).catch(() => false);
  }
  return glimpsePromise;
}

// renderDeckSvgs renders every slide once. Returns null when the library is unavailable or the file
// is not something it can parse, so the caller can fall back.
export async function renderDeckSvgs(buffer, slides) {
  const lib = await glimpse();
  if (lib === false) return null;
  try {
    const selected = Array.isArray(slides) && slides.length > 0 ? { slides } : {};
    const fonts = await measureFonts();
    const options = { textOutput: "text", skipSystemFonts: true, ...selected };
    if (fonts.length > 0) options.fonts = fonts;
    const report = await lib.convertPptxToSvg(buffer, options);
    const svgs = report.slides.map((slide) => slide.svg);
    return svgs.length > 0 ? svgs : null;
  } catch {
    return null;
  }
}

// rasteriseSvg turns a slide SVG into the JPEG the model sees. Text is vector paths, so rsvg-convert
// needs no fonts; only the paths have to be drawn.
export async function rasteriseSvg(svg, { maxEdge = imageMaxEdge(), width = 1600 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-slide-"));
  try {
    const svgPath = path.join(dir, "slide.svg");
    const pngPath = path.join(dir, "slide.png");
    await writeFile(svgPath, svg);
    await run("rsvg-convert", ["-w", String(width), "-o", pngPath, svgPath]);
    return await shrinkImage(await readFile(pngPath), "image/png", { maxEdge });
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
