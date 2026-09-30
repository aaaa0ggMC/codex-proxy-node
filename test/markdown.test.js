import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/markdown.js";

test("headings, paragraphs and rules", () => {
  const html = renderMarkdown("# One\n\nsome text\nstill same paragraph\n\n---\n\n## Two");
  assert.match(html, /<h1>One<\/h1>/);
  assert.match(html, /<p>some text still same paragraph<\/p>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<h2>Two<\/h2>/);
});

test("inline emphasis, code and links", () => {
  const html = renderMarkdown("A **bold** *italic* `code` and a [link](https://example.com/x).");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener">link<\/a>/);
});

test("a link that could run code is reduced to its label", () => {
  const html = renderMarkdown("bad [click](javascript:alert(1)) end");
  assert.ok(!/href/.test(html), html);
  assert.match(html, /bad click end/);
});

test("html in the document is escaped, never executed", () => {
  const html = renderMarkdown("<img src=x onerror=alert(1)>");
  assert.ok(!html.includes("<img"), html);
  assert.match(html, /&lt;img/);
});

test("fenced code keeps its text verbatim", () => {
  const html = renderMarkdown("```js\nconst a = 1 < 2 && `x`;\n```");
  assert.match(html, /<pre><code>const a = 1 &lt; 2 &amp;&amp; `x`;<\/code><\/pre>/);
});

test("four-space indented blocks are code", () => {
  assert.match(renderMarkdown("    plain literal\n    second line"), /<pre><code>plain literal\nsecond line<\/code><\/pre>/);
});

test("lists, including wrapped items", () => {
  const html = renderMarkdown("- **one** first\n  wrapped on\n- two\n\n1. alpha\n2. beta");
  assert.match(html, /<ul><li><strong>one<\/strong> first wrapped on<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>alpha<\/li><li>beta<\/li><\/ol>/);
});

test("blockquotes nest their own blocks", () => {
  assert.match(renderMarkdown("> quoted\n> more"), /<blockquote><p>quoted more<\/p><\/blockquote>/);
});

test("an empty document renders nothing", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown("   \n  "), "");
});
