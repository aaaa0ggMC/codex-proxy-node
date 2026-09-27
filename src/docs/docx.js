import { readZip, resolveZipPath } from "./zip.js";
import { mimeForName, parseRelationships, unescapeXml } from "./pptx.js";

// DOCX is the same container shape as PPTX, so it reuses the zip reader and the relationship parser.
// WordprocessingML uses w:p / w:t rather than DrawingML's a:p / a:t, which is the only new part.
//
// A Word file has no fixed pages — pagination is a rendering decision — so it is reported as a
// single section rather than inventing page boundaries that the document does not have.

export function wordText(xml) {
  if (xml == null) return "";
  const paragraphs = [];
  for (const paragraph of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    let text = "";
    for (const token of paragraph[1].matchAll(/<w:tab\s*\/>|<w:br\s*\/>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
      if (token[0].startsWith("<w:tab")) text += "\t";
      else if (token[0].startsWith("<w:br")) text += "\n";
      else text += unescapeXml(token[1]);
    }
    if (text.trim() !== "") paragraphs.push(text.trim());
  }
  return paragraphs.join("\n");
}

export function parseDocx(buffer) {
  const zip = readZip(buffer);
  const xml = zip.readText("word/document.xml");
  if (xml == null) throw new Error("not a .docx: word/document.xml is missing");

  const images = [];
  for (const rel of parseRelationships(zip.readText("word/_rels/document.xml.rels"))) {
    if (!rel.type.endsWith("/image")) continue;
    const path = resolveZipPath("word", rel.target);
    const data = zip.read(path);
    if (data != null) images.push({ path, mime: mimeForName(path), data, bytes: data.length });
  }

  return { text: wordText(xml), images };
}
