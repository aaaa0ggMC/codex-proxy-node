import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The roots are read when the plugin module loads, so the tree has to exist first.
const root = await mkdtemp(path.join(tmpdir(), "codex-filesearch-"));
await mkdir(path.join(root, "Download", "QQ"), { recursive: true });
await mkdir(path.join(root, "Download", "Pictures"), { recursive: true });
await writeFile(path.join(root, "Download", "QQ", "装在套子里的豆包.pptx"), "x".repeat(2048));
await writeFile(path.join(root, "Download", "Pictures", "cat.png"), "x");
process.env.CODEX_PROXY_FILE_ROOTS = path.join(root, "Download");

const { default: plugin, score } = await import("../plugins/filesearch/index.js");
const search = plugin.tools[0];

test("a fuzzy query finds a file by its path fragment", async () => {
  const result = await search.run({ query: "QQ/装在套子里的豆包" });
  assert.match(result, /装在套子里的豆包\.pptx/);
  assert.match(result, /2KB/);
});

test("a partial name matches, and unrelated files do not", async () => {
  assert.match(await search.run({ query: "豆包" }), /装在套子里的/);
  assert.match(await search.run({ query: "cat" }), /cat\.png/);
  assert.equal(await search.run({ query: "nonexistent-xyz" }), await search.run({ query: "nonexistent-xyz" }));
  assert.match(await search.run({ query: "nonexistent-xyz" }), /No file under/);
});

test("the plugin exposes search and nothing that lists or writes", () => {
  assert.deepEqual(plugin.tools.map((tool) => tool.name), ["search"]);
  assert.equal(plugin.namespace, true);
  const text = JSON.stringify(plugin.tools.map((tool) => tool.name + tool.description).join(" ")).toLowerCase();
  for (const forbidden of ["list", "ls", "write", "delete", "remove", "move"]) {
    assert.ok(!new RegExp(`\\\\b${forbidden}\\\\b`).test(text), `tool surface must not mention ${forbidden}`);
  }
});

test("scoring prefers a name match over a path match", () => {
  assert.ok(score("/a/b/豆包.pptx", "豆包") > score("/a/豆包/b/other.pptx", "豆包"));
  assert.equal(score("/a/b/c.txt", ""), 0);
});
