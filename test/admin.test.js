import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Server } from "../src/server.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { silentLog, startHttpServer } from "../test-support/helpers.js";

function provider() {
  return {
    async *events() {
      yield { type: "response.completed", data: { response: { id: "r", status: "completed" } } };
    },
    async models() {
      return [];
    },
    async usage() {
      return null;
    },
  };
}

async function startConsole(registry = null) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-admin-"));
  const stateFile = path.join(dir, "plugins-state.json");
  const server = new Server({
    provider: provider(),
    log: silentLog,
    apiKey: "",
    registry: registry ?? new ToolRegistry().register({ name: "flowchart", fences: { mermaid: () => "[x]" } }),
    pluginStateFile: stateFile,
  });
  const proxy = await startHttpServer(server.handler());
  return { ...proxy, stateFile };
}

test("toggling a plugin from the console flips it and persists the choice", async () => {
  const cnsl = await startConsole();
  try {
    const page = await (await fetch(`${cnsl.base}/admin/plugins`)).text();
    // The two bugs this guards: a bare fetch(name) resolves to /admin/<name> and 404s, and the
    // console needs the browse catalog, not just the toggle state.
    assert.ok(page.includes("fetch('catalog.json')"), "the console loads the catalog");
    assert.ok(page.includes("fetch('plugins/' + encodeURIComponent(name)"), "the toggle is a child path");
    assert.ok(page.includes("#tool/") && page.includes("#plugin/"), "plugins and tools are navigable");

    const before = await (await fetch(`${cnsl.base}/admin/plugins.json`)).json();
    assert.deepEqual(before.plugins.map((p) => [p.name, p.enabled]), [["flowchart", true]]);

    const off = await fetch(`${cnsl.base}/admin/plugins/flowchart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200);
    assert.deepEqual((await off.json()).plugins.map((p) => [p.name, p.enabled]), [["flowchart", false]]);
    assert.deepEqual(JSON.parse(await readFile(cnsl.stateFile, "utf8")), { disabled: ["flowchart"] });

    const on = await fetch(`${cnsl.base}/admin/plugins/flowchart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(on.status, 200);
    assert.deepEqual(JSON.parse(await readFile(cnsl.stateFile, "utf8")), { disabled: [] });
  } finally {
    await cnsl.close();
  }
});

test("the catalog carries each tool's schema and rendered docs", async () => {
  const parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  const registry = new ToolRegistry()
    .register({ name: "almanac", docs: "# Almanac\n\nPlugin level **doc**." })
    .register({
      name: "reader",
      namespace: true,
      tools: [
        {
          name: "open",
          description: "Open a thing",
          parameters,
          docs: "## open\n\nPass a `path`.",
          run: async () => "ok",
        },
      ],
    });

  const cnsl = await startConsole(registry);
  try {
    const { plugins } = await (await fetch(`${cnsl.base}/admin/catalog.json`)).json();

    const almanac = plugins.find((p) => p.name === "almanac");
    assert.equal(almanac.tools.length, 0);
    assert.match(almanac.docsHTML, /<h1>Almanac<\/h1>/);
    assert.match(almanac.docsHTML, /<strong>doc<\/strong>/);

    const open = plugins.find((p) => p.name === "reader").tools[0];
    assert.equal(open.name, "proxy_reader_open");
    // The exact declaration the model is given, namespaced, with the parameters untouched.
    assert.deepEqual(open.schema, {
      type: "function",
      name: "proxy_reader_open",
      description: "Open a thing",
      parameters,
    });
    assert.match(open.docsHTML, /<code>path<\/code>/);
  } finally {
    await cnsl.close();
  }
});

test("an unknown plugin is a 404 the page can show", async () => {
  const cnsl = await startConsole();
  try {
    const resp = await fetch(`${cnsl.base}/admin/plugins/nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(resp.status, 404);
    assert.match((await resp.json()).error, /unknown plugin/);
  } finally {
    await cnsl.close();
  }
});
