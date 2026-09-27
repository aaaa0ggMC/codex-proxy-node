import { readZip } from "./zip.js";
import { parseRelationships, unescapeXml } from "./pptx.js";

// Spreadsheets and plain text are not rendered, they are read: a sheet becomes CSV-shaped text, so
// the model sees the same grid a person would, without a layout engine.

export const TEXT_EXTENSIONS = [
  ".md", ".markdown", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".log", ".srt",
  ".yaml", ".yml", ".toml", ".ini", ".xml", ".html", ".css",
  ".js", ".mjs", ".cjs", ".ts", ".py", ".sh", ".go", ".rs", ".java", ".c", ".h", ".cpp",
];

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

function sharedStrings(zip) {
  const xml = zip.readText("xl/sharedStrings.xml");
  if (xml == null) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((entry) =>
    [...entry[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join(""),
  );
}

function cellValue(cell, strings) {
  const type = /\bt="([^"]+)"/.exec(cell)?.[1] ?? "";
  if (type === "inlineStr") {
    return [...cell.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1])).join("");
  }
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? "";
  if (type === "s") return strings[Number(raw)] ?? "";
  return unescapeXml(raw);
}

function csvEscape(value) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function columnIndex(reference) {
  const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? "A";
  let index = 0;
  for (const character of letters) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

export function sheetToCsv(xml, strings) {
  const rows = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of row[1].matchAll(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g)) {
      const reference = /\br="([A-Z]+\d+)"/.exec(cell[0])?.[1] ?? "";
      cells[columnIndex(reference)] = csvEscape(cellValue(cell[0], strings));
    }
    rows.push([...cells].map((value) => value ?? "").join(","));
  }
  return rows.join("\n");
}

// A workbook is presented as one section per sheet, because "sheet" is the unit the document
// actually has — the same reasoning that makes a Word file a single section.
export function parseXlsx(buffer) {
  const zip = readZip(buffer);
  const rels = new Map(
    parseRelationships(zip.readText("xl/_rels/workbook.xml.rels")).map((rel) => [rel.id, rel.target]),
  );
  const strings = sharedStrings(zip);
  const workbook = zip.readText("xl/workbook.xml") ?? "";

  const sheets = [];
  for (const entry of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(entry[0])?.[1] ?? `sheet ${sheets.length + 1}`;
    const id = /\br:id="([^"]*)"/.exec(entry[0])?.[1] ?? "";
    const target = rels.get(id);
    const xml = target == null ? null : zip.readText(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    if (xml == null) continue;
    sheets.push({ name: unescapeXml(name), csv: sheetToCsv(xml, strings) });
  }
  if (sheets.length === 0) throw new Error("not a readable .xlsx: no worksheets found");
  return { sheets };
}
