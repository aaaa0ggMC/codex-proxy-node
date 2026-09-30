import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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

  assert.deepEqual([...registry.names()], ["proxy_docs_read"]);
  assert.equal(registry.owns("proxy_docs_read"), true);
  assert.equal(registry.owns("read"), false);
  assert.equal(registry.definitions()[0].name, "proxy_docs_read");
  assert.ok(lines.some((line) => /duplicate tool/.test(line.error)), "the clash should be reported");
});

test("a missing plugins directory is not an error", async () => {
  assert.deepEqual(await loadPlugins(path.join(tmpdir(), "codex-plugins-does-not-exist")), []);
});

test("no plugin's model-facing text points at a pre-namespace tool alias", async () => {
  const plugins = await loadPlugins(path.join(import.meta.dirname, "..", "plugins"));
  assert.ok(plugins.length > 0, "the shipped plugins must load");
  for (const plugin of plugins) {
    const text = JSON.stringify(plugin);
    for (const tool of plugin.tools ?? []) {
      const alias = `${plugin.name}__${tool.name}`;
      assert.ok(!text.includes(alias), `${plugin.name} still points at the old alias ${alias}`);
    }
  }
});

test("tool names are assembled in one place, never pasted into source", async () => {
  const root = path.join(import.meta.dirname, "..");
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  await walk(path.join(root, "src"));
  await walk(path.join(root, "plugins"));
  const offenders = [];
  for (const file of files) {
    if (file === path.join(root, "src", "agent", "names.js")) continue;
    if (/proxy_[a-z]/.test(await readFile(file, "utf8"))) offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, [], `hardcoded tool-name prefix; build names with toolName() from src/agent/names.js: ${offenders.join(", ")}`);
});
