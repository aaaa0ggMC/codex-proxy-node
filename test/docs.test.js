import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readZip, resolveZipPath } from "../src/docs/zip.js";
import { mimeForName, parsePptx, shapeText, unescapeXml } from "../src/docs/pptx.js";
import { writeZip } from "../test-support/zip-build.js";
import { makePng } from "../test-support/png.js";

const tinyPng = makePng(8, 8);

// A miniature deck whose slide order (2 then 1) differs from the numeric filenames, so the test
// proves the order comes from presentation.xml rather than from sorting.
function miniPptx() {
  return writeZip([
    [
      "ppt/presentation.xml",
      `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      `<Relationships>
        <Relationship Id="rId1" Type="http://x/slide" Target="slides/slide1.xml"/>
        <Relationship Id="rId2" Type="http://x/slide" Target="slides/slide2.xml"/>
      </Relationships>`,
    ],
    [
      "ppt/slides/slide1.xml",
      `<p:sld><p:cSld><p:spTree><a:p><a:r><a:t>Second slide &amp; friends</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
    ],
    [
      "ppt/slides/slide2.xml",
      `<p:sld><p:cSld><p:spTree>
        <a:p><a:r><a:t>First slide</a:t></a:r></a:p>
        <a:p><a:r><a:t>with a second</a:t></a:r><a:br/><a:r><a:t>line</a:t></a:r></a:p>
      </p:spTree></p:cSld></p:sld>`,
    ],
    [
      "ppt/slides/_rels/slide2.xml.rels",
      `<Relationships>
        <Relationship Id="rId1" Type="http://x/image" Target="../media/pic.png"/>
        <Relationship Id="rId2" Type="http://x/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
      </Relationships>`,
    ],
    ["ppt/media/pic.png", tinyPng],
    ["ppt/notesSlides/notesSlide1.xml", `<p:notes><a:p><a:r><a:t>speaker note</a:t></a:r></a:p></p:notes>`],
  ]);
}

test("readZip round-trips entries and resolves relative paths", () => {
  const zip = readZip(writeZip([["a/b.txt", "hello"], ["a/", ""]]));
  assert.deepEqual(zip.names(), ["a/b.txt", "a/"]);
  assert.equal(zip.readText("a/b.txt"), "hello");
  assert.equal(zip.read("missing.txt"), null);

  assert.equal(resolveZipPath("ppt/slides", "../media/pic.png"), "ppt/media/pic.png");
  assert.equal(resolveZipPath("ppt", "slides/slide1.xml"), "ppt/slides/slide1.xml");
});

test("shapeText keeps paragraphs and line breaks", () => {
  const xml = `<a:p><a:r><a:t>one</a:t></a:r></a:p><a:p><a:r><a:t>two</a:t></a:r><a:br/><a:r><a:t>three</a:t></a:r></a:p>`;
  assert.equal(shapeText(xml), "one\ntwo\nthree");
  assert.equal(unescapeXml("a &amp; b &lt;c&gt; &#65;"), "a & b <c> A");
});

test("parsePptx follows presentation order and extracts text, notes and images", () => {
  const deck = parsePptx(miniPptx());

  assert.equal(deck.slides.length, 2);
  assert.equal(deck.slides[0].number, 1);
  assert.equal(deck.slides[0].title, "First slide");
  assert.equal(deck.slides[0].text, "First slide\nwith a second\nline");
  assert.equal(deck.slides[0].notes, "speaker note");
  assert.equal(deck.slides[1].text, "Second slide & friends");

  assert.equal(deck.slides[0].images.length, 1);
  assert.equal(deck.slides[0].images[0].path, "ppt/media/pic.png");
  assert.equal(deck.slides[0].images[0].mime, "image/png");
  assert.deepEqual(deck.slides[0].images[0].data, tinyPng);
  assert.deepEqual(deck.slides[1].images, []);
});

test("parsePptx reads a real deck when one is available", (t) => {
  const file = process.env.CODEX_PROXY_TEST_PPTX;
  if (!file) return t.skip("set CODEX_PROXY_TEST_PPTX to a .pptx to run this");

  const deck = parsePptx(readFileSync(file));
  assert.ok(deck.slides.length > 0);
  assert.ok(deck.slides.some((slide) => slide.text !== ""), "at least one slide should have text");
  for (const slide of deck.slides) {
    for (const image of slide.images) assert.equal(mimeForName(image.path).startsWith("image/"), true);
  }
});
