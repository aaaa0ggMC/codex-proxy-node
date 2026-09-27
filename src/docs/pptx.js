import { readZip, resolveZipPath } from "./zip.js";

// PPTX is a zip of XML. Rather than re-implementing a layout engine (there is no LibreOffice on
// this device), a slide becomes the two things a model can actually use: its text, and the images
// it embeds. Charts and diagrams in a deck are almost always pictures, so this covers the
// interesting content without pretending to render shapes faithfully.

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function unescapeXml(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return ENTITIES[entity] ?? match;
  });
}

function attributesOf(tag) {
  const out = {};
  for (const match of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g)) {
    out[match[1]] = unescapeXml(match[2]);
  }
  return out;
}

// parseRelationships reads the OOXML .rels format: a flat list of Relationship elements.
export function parseRelationships(xml) {
  if (xml == null) return [];
  const out = [];
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const attrs = attributesOf(match[0]);
    if (attrs.Id) out.push({ id: attrs.Id, type: attrs.Type ?? "", target: attrs.Target ?? "" });
  }
  return out;
}

// shapeText walks the DrawingML text body rather than just scraping <a:t>, so paragraph breaks and
// explicit line breaks survive into something a model can read.
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
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  emf: "image/emf",
  wmf: "image/wmf",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export function mimeForName(name) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function slideOrder(zip) {
  const presentation = zip.readText("ppt/presentation.xml");
  const rels = parseRelationships(zip.readText("ppt/_rels/presentation.xml.rels"));
  const byId = new Map(rels.map((rel) => [rel.id, rel.target]));

  const ordered = [];
  for (const match of (presentation ?? "").matchAll(/<p:sldId\b[^>]*>/g)) {
    const attrs = attributesOf(match[0]);
    const target = byId.get(attrs["r:id"]);
    if (target) ordered.push(resolveZipPath("ppt", target));
  }
  if (ordered.length > 0) return ordered;

  // Fall back to the numeric order of the slide parts if the presentation part is unreadable.
  return zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
}

export function parsePptx(buffer) {
  const zip = readZip(buffer);
  const slides = [];

  for (const [position, slidePath] of slideOrder(zip).entries()) {
    const xml = zip.readText(slidePath);
    if (xml == null) continue;

    const relsPath = `${slidePath.slice(0, slidePath.lastIndexOf("/"))}/_rels/${slidePath.slice(slidePath.lastIndexOf("/") + 1)}.rels`;
    const rels = parseRelationships(zip.readText(relsPath));
    const baseDir = slidePath.slice(0, slidePath.lastIndexOf("/"));

    const images = [];
    for (const rel of rels) {
      if (!rel.type.endsWith("/image")) continue;
      const path = resolveZipPath(baseDir, rel.target);
      const data = zip.read(path);
      if (data == null) continue;
      images.push({ path, mime: mimeForName(path), data, bytes: data.length });
    }

    let notes = "";
    for (const rel of rels) {
      if (!rel.type.endsWith("/notesSlide")) continue;
      const path = resolveZipPath(baseDir, rel.target);
      notes = shapeText(zip.readText(path));
    }

    slides.push({
      number: position + 1,
      path: slidePath,
      title: shapeText(xml).split("\n")[0] ?? "",
      text: shapeText(xml),
      notes,
      images,
    });
  }

  return { kind: "pptx", slides };
}
