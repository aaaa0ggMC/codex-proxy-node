import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { outlineOf, searchPages } from "../src/docs/document.js";
import { buildRegistry, loadPlugins } from "../src/plugins/loader.js";
import { writeZip } from "../test-support/zip-build.js";
import { makePng } from "../test-support/png.js";

const tinyPng = makePng(8, 8);

test("searchPages reports page numbers and snippets", () => {
  const pages = ["alpha beta", "gamma REVENUE grew", "nothing here"];
  const hits = searchPages(pages, "revenue");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].page, 2);
  assert.match(hits[0].snippets[0], /REVENUE grew/);
  assert.deepEqual(searchPages(pages, "  "), []);
  assert.deepEqual(searchPages(pages, "absent"), []);
});

test("outlineOf summarises a document without reading images", async () => {
  const document = {
    name: "deck.pptx",
    kind: "pptx",
    bytes: 2048,
    pageCount: 3,
    pageLabel: "slide",
    text: async (page) => `slide ${page} body`,
  };
  const outline = await outlineOf(document);
  assert.match(outline, /deck\.pptx \(pptx, 3 slides, 2KB\)/);
  assert.match(outline, /2\. slide 2 body/);
});

async function fixtureDeck() {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-docs-"));
  const file = path.join(dir, "mini.pptx");
  await writeFile(
    file,
    writeZip([
      ["ppt/presentation.xml", `<p:sldIdLst><p:sldId r:id="rId1"/><p:sldId r:id="rId2"/></p:sldIdLst>`],
      [
        "ppt/_rels/presentation.xml.rels",
        `<Relationships><Relationship Id="rId1" Type="t/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="t/slide" Target="slides/slide2.xml"/></Relationships>`,
      ],
      ["ppt/slides/slide1.xml", `<a:p><a:r><a:t>Intro to widgets</a:t></a:r></a:p>`],
      ["ppt/slides/slide2.xml", `<a:p><a:r><a:t>Widget revenue grew 32 percent</a:t></a:r></a:p>`],
      [
        "ppt/slides/_rels/slide2.xml.rels",
        `<Relationships><Relationship Id="rId1" Type="t/image" Target="../media/pic.png"/></Relationships>`,
      ],
      ["ppt/media/pic.png", tinyPng],
    ]),
  );
  return file;
}

test("the docs plugin opens, searches and reads pages as text plus images", async () => {
  const registry = buildRegistry(await loadPlugins(path.join(import.meta.dirname, "..", "plugins")));
  assert.deepEqual(
    [...registry.names()].sort(),
    ["docs__list", "docs__open", "docs__read_page", "docs__search"],
  );

  const file = await fixtureDeck();
  const opened = await registry.call("docs__open", JSON.stringify({ path: file }));
  const docId = opened.split("\n")[0].split(" ")[1];
  assert.match(opened, /mini\.pptx \(pptx, 2 slides/);

  const listed = await registry.call("docs__list", "{}");
  assert.match(listed, /mini\.pptx/);

  // The file name is accepted as a reference too, not just the id.
  const hits = await registry.call("docs__search", JSON.stringify({ doc: "mini.pptx", query: "revenue" }));
  assert.match(hits, /slide 2:/);

  const page = await registry.call("docs__read_page", JSON.stringify({ doc: docId, page: 2 }));
  assert.match(page[0].text, /Widget revenue grew 32 percent/);
  assert.equal(page.filter((part) => part.type === "input_image").length, 1);
  assert.match(page[1].image_url, /^data:image\//);

  const textOnly = await registry.call("docs__read_page", JSON.stringify({ doc: docId, page: 2, images: false }));
  assert.equal(textOnly.length, 1);
});

test("the docs plugin rejects a page outside the document", async () => {
  const registry = buildRegistry(await loadPlugins(path.join(import.meta.dirname, "..", "plugins")));
  const file = await fixtureDeck();
  const opened = await registry.call("docs__open", JSON.stringify({ path: file }));
  const docId = opened.split("\n")[0].split(" ")[1];
  await assert.rejects(
    registry.call("docs__read_page", JSON.stringify({ doc: docId, page: 9 })),
    /page must be an integer between 1 and 2/,
  );
  await assert.rejects(registry.call("docs__search", JSON.stringify({ doc: "nope.pptx", query: "x" })), /no open document/);
});
