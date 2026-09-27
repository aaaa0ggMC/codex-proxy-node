import { test } from "node:test";
import assert from "node:assert/strict";
import { HelpRequested, isLoopbackHost, parseFlags } from "../src/config.js";

test("parseFlags applies the documented defaults", () => {
  assert.deepEqual(parseFlags([], {}), {
    host: "127.0.0.1",
    port: 6769,
    codexHome: "",
    apiKey: "",
    webSearch: false,
    provider: "codex",
    upstream: "",
    upstreamKey: "",
    upstreamModel: "",
    reasoningEffort: "",
    maxTurns: 256,
    discardImages: 0,
    config: "",
  });
});

test("parseFlags wires up an OpenAI-compatible provider", () => {
  const cfg = parseFlags(["--provider", "openai", "--upstream", "https://api.stepfun.ai/step_plan/v1"], {});
  assert.equal(cfg.provider, "openai");
  assert.equal(cfg.upstream, "https://api.stepfun.ai/step_plan/v1");

  const fromEnv = parseFlags([], {
    CODEX_PROXY_PROVIDER: "openai",
    CODEX_PROXY_UPSTREAM: "https://api.deepseek.com/v1",
    CODEX_PROXY_UPSTREAM_KEY: "sk-test",
    CODEX_PROXY_UPSTREAM_MODEL: "deepseek-chat",
    CODEX_PROXY_REASONING_EFFORT: "low",
  });
  assert.equal(fromEnv.upstreamKey, "sk-test");
  assert.equal(fromEnv.upstreamModel, "deepseek-chat");
  assert.equal(fromEnv.reasoningEffort, "low");
});

test("parseFlags rejects a provider it cannot build", () => {
  assert.throws(() => parseFlags(["--provider", "openai"], {}), /requires --upstream/);
  assert.throws(() => parseFlags(["--provider", "gemini"], {}), /unknown --provider/);
});

test("parseFlags accepts both dashes and both value forms", () => {
  assert.equal(parseFlags(["--port", "7000"], {}).port, 7000);
  assert.equal(parseFlags(["--port=7000"], {}).port, 7000);
  assert.equal(parseFlags(["-port", "7000"], {}).port, 7000);
  assert.equal(parseFlags(["-port=7000"], {}).port, 7000);
  assert.equal(parseFlags(["--host", "0.0.0.0", "--api-key", "k"], {}).host, "0.0.0.0");
});

test("parseFlags handles the boolean web search flag", () => {
  assert.equal(parseFlags(["--web-search"], {}).webSearch, true);
  assert.equal(parseFlags(["--web-search=false"], {}).webSearch, false);
  assert.equal(parseFlags(["-web-search"], {}).webSearch, true);
});

test("parseFlags reads the environment fallbacks", () => {
  assert.equal(parseFlags([], { CODEX_PROXY_API_KEY: "env" }).apiKey, "env");
  assert.equal(parseFlags(["--api-key", "cli"], { CODEX_PROXY_API_KEY: "env" }).apiKey, "cli");
  assert.equal(parseFlags([], { CODEX_PROXY_WEB_SEARCH: "1" }).webSearch, true);
  assert.equal(parseFlags([], { CODEX_PROXY_WEB_SEARCH: "off" }).webSearch, false);
  assert.equal(parseFlags(["--web-search"], { CODEX_PROXY_WEB_SEARCH: "0" }).webSearch, true);
});

test("parseFlags refuses a public bind without an API key", () => {
  assert.throws(() => parseFlags(["--host", "0.0.0.0"], {}), /refusing to listen on non-loopback host/);
});

test("parseFlags rejects unknown flags, stray arguments and bad ports", () => {
  assert.throws(() => parseFlags(["--nope"], {}), /flag provided but not defined/);
  assert.throws(() => parseFlags(["extra"], {}), /unexpected argument/);
  assert.throws(() => parseFlags(["--port"], {}), /flag needs an argument/);
  assert.throws(() => parseFlags(["--port", "70000"], {}), /invalid --port/);
  assert.throws(() => parseFlags(["--port", "abc"], {}), /invalid value/);
});

test("parseFlags reports help instead of failing", () => {
  assert.throws(() => parseFlags(["--help"], {}), HelpRequested);
  assert.throws(() => parseFlags(["-h"], {}), HelpRequested);
});

test("isLoopbackHost recognises loopback names and addresses", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.0.0.53"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("example.com"), false);
});
