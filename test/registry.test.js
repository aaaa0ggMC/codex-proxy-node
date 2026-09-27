import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderRegistry, loadProviderConfig, stripSearch } from "../src/providers/registry.js";

function fakeProvider(name, slugs, seen) {
  return {
    id: name,
    async models() {
      return slugs.map((slug) => ({ slug, supported_in_api: true, visibility: "list" }));
    },
    async *events(request) {
      seen.push({ provider: name, model: request.model });
      yield { type: "response.completed", data: { type: "response.completed", response: { id: "resp_x" } } };
    },
    async usage() {
      return { plan_type: name };
    },
  };
}

function registry(seen = []) {
  return new ProviderRegistry({
    defaultProvider: "codex",
    providers: [
      ["codex", fakeProvider("codex", ["gpt-5.6-luna"], seen)],
      ["deepseek", fakeProvider("deepseek", ["deepseek-flash", "shared-model"], seen)],
      ["other", fakeProvider("other", ["shared-model"], seen)],
    ],
  });
}

test("models aggregates every provider, prefixing ids and keeping unique bare ones", async () => {
  const ids = (await registry().models()).map((m) => m.slug);
  for (const id of ["codex/gpt-5.6-luna", "deepseek/deepseek-flash", "deepseek/shared-model", "other/shared-model"]) {
    assert.ok(ids.includes(id), `expected ${id} in ${ids.join(", ")}`);
  }
  assert.ok(ids.includes("gpt-5.6-luna"), "a unique bare id must stay listed for saved histories");
  assert.ok(!ids.includes("shared-model"), "an ambiguous bare id must not be advertised");
});

test("route prefers an explicit prefix, then a unique bare id, then the default", async () => {
  const r = registry();
  assert.deepEqual(await r.route("deepseek/deepseek-flash"), { provider: "deepseek", model: "deepseek-flash" });
  assert.deepEqual(await r.route("gpt-5.6-luna"), { provider: "codex", model: "gpt-5.6-luna" });
  assert.deepEqual(await r.route("deepseek-flash"), { provider: "deepseek", model: "deepseek-flash" });
  assert.deepEqual(await r.route("shared-model"), { provider: "codex", model: "shared-model" });
  assert.deepEqual(await r.route("nobody/unknown"), { provider: "codex", model: "nobody/unknown" });
});

test("events are delegated to the routed provider, with the prefix stripped", async () => {
  const seen = [];
  const r = registry(seen);
  for await (const _ of r.events({ model: "deepseek/deepseek-flash", input: [] })) {
    // drain
  }
  assert.deepEqual(seen, [{ provider: "deepseek", model: "deepseek-flash" }]);
});

test("a search alias routes on the base model id", () => {
  assert.equal(stripSearch("gpt-5.6-luna-search-preview"), "gpt-5.6-luna");
  assert.equal(stripSearch("gpt-5.6-luna-search"), "gpt-5.6-luna");
  assert.equal(stripSearch("deepseek-flash"), "deepseek-flash");
});

test("one unreachable provider does not blank the catalogue", async () => {
  const broken = { id: "broken", models: async () => { throw new Error("down"); }, async *events() {}, usage: async () => null };
  const r = new ProviderRegistry({
    defaultProvider: "codex",
    providers: [["broken", broken], ["codex", fakeProvider("codex", ["m1"])]],
  });
  const ids = (await r.models()).map((m) => m.slug);
  assert.deepEqual(ids, ["codex/m1", "m1"]);
});

test("loadProviderConfig skips disabled and unknown providers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-providers-"));
  const file = path.join(dir, "config.json");
  await writeFile(
    file,
    JSON.stringify({
      default_provider: "deepseek",
      providers: {
        deepseek: { type: "openai", base_url: "https://example.com/v1", api_key_env: "NOPE" },
        off: { type: "openai", enabled: false, base_url: "https://example.com/v1" },
        weird: { type: "telepathy" },
        broken: { type: "openai" },
      },
    }),
  );

  const { defaultProvider, providers } = await loadProviderConfig(file);
  assert.equal(defaultProvider, "deepseek");
  assert.deepEqual(providers.map(([name]) => name), ["deepseek"]);

  const viaEnv = JSON.parse(await readFile(file, "utf8"));
  assert.equal(viaEnv.providers.deepseek.api_key_env, "NOPE", "keys stay in the environment");
});
