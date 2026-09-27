import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseXlsx, sheetToCsv } from "../src/docs/sheet.js";
import { openDocument } from "../src/docs/document.js";
import { writeZip } from "../test-support/zip-build.js";

test("a sheet becomes CSV-shaped text", () => {
  const xml = `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>hi, there</t></is></c></row>`;
  assert.equal(sheetToCsv(xml, ["name", "revenue"]), 'name,42\nrevenue,"hi, there"');
});

test("a workbook yields one section per sheet", () => {
  const book = writeZip([
    ["xl/workbook.xml", `<workbook><sheets><sheet name="Q1" r:id="rId1"/><sheet name="Q2" r:id="rId2"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<sst><si><t>revenue</t></si></sst>`],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>32</v></c></row></sheetData></worksheet>`],
    ["xl/worksheets/sheet2.xml", `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`],
  ]);
  const parsed = parseXlsx(book);
  assert.deepEqual(parsed.sheets.map((s) => s.name), ["Q1", "Q2"]);
  assert.equal(parsed.sheets[0].csv, "revenue,32");
});

test("text files open as one section, and images cannot be rendered", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-sheet-"));
  const csv = path.join(dir, "data.csv");
  await writeFile(csv, "a,b\n1,2\n");
  const document = await openDocument(csv);
  assert.equal(document.kind, "csv");
  assert.equal(document.pageCount, 1);
  assert.equal(document.imageSupport, false);
  assert.match(await document.text(1), /a,b/);
  assert.deepEqual(await document.images(1), []);
});
