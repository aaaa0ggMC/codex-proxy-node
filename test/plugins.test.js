import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRegistry, loadPlugins } from "../src/plugins/loader.js";

function collector() {
  const lines = [];
  return {
    lines,
    log: {
      info: (message, fields) => lines.push({ message, ...fields }),
      warn: () => {},
      error: (message, fields) => lines.push({ message, ...fields }),
      child: () => collector().log,
    },
  };
}

async function pluginDir(folders) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-plugins-"));
  for (const [name, source] of Object.entries(folders)) {
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, "index.js"), source);
  }
  return dir;
}

const good = (name, tool) => `
export default {
  name: ${JSON.stringify(name)},
  namespace: true,
  tools: [{ name: ${JSON.stringify(tool)}, run: async () => "ok" }],
};`;

test("loadPlugins loads folders in sorted order and skips underscored ones", async () => {
  const dir = await pluginDir({
    zeta: good("zeta", "z"),
    alpha: good("alpha", "a"),
    _example: good("example", "never"),
  });

  const plugins = await loadPlugins(dir);
  assert.deepEqual(plugins.map((p) => p.name), ["alpha", "zeta"]);
});

test("a folder renamed with a leading dash is disabled, not loaded", async () => {
  const dir = await pluginDir({
    "-docs": good("docs", "read"),
    "live": good("live", "ok"),
  });

  const { lines, log } = collector();
  const plugins = await loadPlugins(dir, { log });

  assert.deepEqual(plugins.map((p) => p.name), ["live"]);
  const disabled = lines.find((line) => line.message === "plugin disabled by name");
  assert.ok(disabled, `expected a disable log in ${JSON.stringify(lines)}`);
  assert.equal(disabled.plugin, "-docs");
  assert.equal(disabled.rename, "docs", "the log should say what to rename it back to");
});

test("loadPlugins survives a broken plugin", async () => {
  const dir = await pluginDir({
    broken: "throw new Error('nope');",
    fine: good("fine", "ok"),
  });

  const { lines, log } = collector();
  const plugins = await loadPlugins(dir, { log });
  assert.deepEqual(plugins.map((p) => p.name), ["fine"]);
  assert.equal(lines.length, 1);
  assert.match(lines[0].error, /nope/);
});

test("buildRegistry namespaces tools and skips a plugin that misbehaves", async () => {
  const dir = await pluginDir({
    docs: good("docs", "read"),
    clash: good("docs", "read"),
  });

  const { lines, log } = collector();
  const registry = buildRegistry(await loadPlugins(dir), { log });

  assert.deepEqual([...registry.names()], ["docs__read"]);
  assert.equal(registry.owns("docs__read"), true);
  assert.equal(registry.owns("read"), false);
  assert.equal(registry.definitions()[0].name, "docs__read");
  assert.ok(lines.some((line) => /duplicate tool/.test(line.error)), "the clash should be reported");
});

test("a missing plugins directory is not an error", async () => {
  assert.deepEqual(await loadPlugins(path.join(tmpdir(), "codex-plugins-does-not-exist")), []);
});
