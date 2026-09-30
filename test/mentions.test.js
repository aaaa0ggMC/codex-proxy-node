import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/agent/tools.js";
import { Server } from "../src/server.js";
import { silentLog, startHttpServer } from "../test-support/helpers.js";
import mentions from "../plugins/mentions/index.js";
import { applyModuleSwitches, enabledModules } from "../src/modules.js";

const LORE = "TARGET LORE";
const flowless = () => new ToolRegistry().register({ name: "target", lore: LORE }).register(mentions);

function registry() {
  return new ToolRegistry().register({ name: "target", lore: "TARGET LORE" }).register(mentions);
}
const input = (text) => [{ role: "user", content: text }];
const run = (reg, inp, switches = []) => reg.contribute({ input: inp }, { switches });
const EMPTY = { append: [], notes: [], carried: [] };

test("mentions and mixed switch syntax obey textual order, and assistant mentions cannot enable tools", () => {
  for (const [text, enabled] of [
    ['<disable_module name="docs" /> @plugin:docs', true],
    ['@plugin:docs <disable_module>docs</disable_module>', false],
    ['<disable_module name="docs" /><enable_module>docs</enable_module>', true],
    ['<enable_module>docs</enable_module><disable_module name="docs" />', false],
  ]) {
    const parsed = applyModuleSwitches([{ role: "user", content: text }], ["docs"]);
    const include = enabledModules(parsed.switches, ["docs"]);
    assert.equal(include.has("docs") && !parsed.disabled.has("docs"), enabled, text);
  }
  assert.deepEqual(applyModuleSwitches([{ role: "assistant", content: "@plugin:docs" }], ["docs"]).switches, []);
});

for (const endpoint of ["chat/completions", "responses"]) {
  test(`${endpoint}: a mention activates tools, instructions and docs with no lore or mentions plugin`, async () => {
    const sink = {};
    const reg = new ToolRegistry().register({
      name: "docs", docs: "MODULE_REFERENCE", instructions: "MODULE_INSTRUCTIONS",
      tools: [{ name: "open", description: "Open a document", parameters: { type: "object", properties: { path: { type: "string" } } }, run: async () => "opened" }],
    });
    reg.setEnabled("docs", false);
    const proxy = await startProxy(scriptedProvider(sink), reg);
    try {
      const send = async (messages) => {
        const data = endpoint === "responses" ? { input: messages } : { messages };
        const response = await post(`${proxy.base}/v1/${endpoint}`, { model: "m", ...data });
        assert.equal(response.status, 200);
        return response.json();
      };
      const first = await send([{ role: "user", content: "@plugin:docs analyze it" }]);
      assert.ok(sink.request.tools.some((t) => t.name === "proxy_docs_open"));
      assert.match(sink.request.instructions, /MODULE_INSTRUCTIONS/);
      assert.doesNotMatch(JSON.stringify(sink.request.input), /MODULE_REFERENCE/, "the console docs must not reach the model");
      assert.match(JSON.stringify(first), /plugin-inject|proxy-context/);
      assert.equal(reg.isEnabled("docs"), false, "conversation activation does not alter the global default");
      await send([{ role: "user", content: "@plugin:docs analyze it" }, { role: "user", content: "continue" }]);
      assert.ok(sink.request.tools.some((t) => t.name === "proxy_docs_open"));
      await send([{ role: "user", content: "@plugin:docs <disable_module>docs</disable_module>" }]);
      assert.ok(!sink.request.tools.some((t) => t.name === "proxy_docs_open"));
      assert.ok(!sink.request.instructions.includes("MODULE_INSTRUCTIONS"));
      assert.ok(!JSON.stringify(sink.request.input).includes("MODULE_REFERENCE"));
    } finally {
      await proxy.close();
    }
  });
}

test("a @plugin mention attaches the named plugin's lore as a carried block", () => {
  const out = run(registry(), input("please use @plugin:target"));
  assert.equal(out.append.length, 1);
  assert.equal(out.append[0].role, "developer");
  assert.equal(out.append[0].content, '<plugin-inject name="target">\nTARGET LORE\n</plugin-inject>');
  assert.deepEqual(out.carried, [out.append[0].content], "the same text goes to the model and to thinking");
});

test("an <enable_module> switch is a trigger too", () => {
  const out = run(registry(), input("go"), [{ verb: "enable", name: "target" }]);
  assert.deepEqual(out.carried, ['<plugin-inject name="target">\nTARGET LORE\n</plugin-inject>']);
  assert.deepEqual(run(registry(), input("go"), [{ verb: "disable", name: "target" }]), EMPTY);
});

test("a mention of an unknown plugin contributes nothing", () => {
  assert.deepEqual(run(registry(), input("@plugin:missing")), EMPTY);
});

test("a mention ignores the target plugin's enabled state", () => {
  const off = registry();
  off.setEnabled("target", false);
  assert.equal(run(off, input("@plugin:target")).carried.length, 1);
  assert.equal(run(registry(), input("@plugin:target"), []).carried.length, 1);
});

test("any user message arms it, so an earlier activation still counts", () => {
  const history = [
    { role: "user", content: "@plugin:target" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "a follow-up with no marker" },
  ];
  assert.equal(run(registry(), history).carried.length, 1);
});

test("a reference the client already carries is not attached again", () => {
  const reg = registry();
  const block = run(reg, input("@plugin:target")).carried[0];
  // chat rail: the proxy lifted it back as a developer message
  assert.deepEqual(
    run(reg, [...input("@plugin:target"), { role: "developer", content: `Context carried over from earlier turns:\nTARGET LORE` }]),
    EMPTY,
  );
  // responses rail: still sitting in the replayed thinking
  assert.deepEqual(
    run(reg, [...input("@plugin:target"), { type: "reasoning", content: [{ type: "reasoning_text", text: block }] }]),
    EMPTY,
  );
});

test("repeated mentions attach once, in first-seen order", () => {
  const reg = new ToolRegistry()
    .register({ name: "beta", lore: "B" })
    .register({ name: "alpha", lore: "A" })
    .register(mentions);
  const out = run(reg, input("@plugin:beta then @plugin:alpha then @plugin:beta"));
  assert.deepEqual(out.carried.map((block) => block.match(/name="([^"]+)"/)[1]), ["beta", "alpha"]);
});

test("only the user arms it, and the result is deterministic", () => {
  const reg = registry();
  assert.deepEqual(run(reg, [{ role: "assistant", content: "@plugin:target" }]), EMPTY);
  assert.deepEqual(run(reg, input("@plugin:target")), run(reg, input("@plugin:target")));
});

test("a mention is read out of structured content parts too", () => {
  const out = run(registry(), [{ role: "user", content: [{ type: "input_text", text: "use @plugin:target" }] }]);
  assert.equal(out.carried.length, 1);
});

// --- end to end through the transports ---

test("a final explicit disable suppresses the module reference", () => {
  const out = registry().contribute({ input: input("@plugin:target") }, { exclude: ["target"] });
  assert.deepEqual(out, EMPTY);
});


function scriptedProvider(sink = {}) {
  return {
    async *events(request) {
      sink.request = request;
      yield { type: "response.output_text.delta", data: { delta: "ok" } };
      yield {
        type: "response.output_item.done",
        data: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
      };
      yield { type: "response.completed", data: { response: { id: "r", status: "completed", usage: {} } } };
    },
    async models() {
      return [];
    },
    async usage() {
      return null;
    },
  };
}

async function startProxy(provider, reg) {
  const server = new Server({ provider, log: silentLog, usageTTL: 60, registry: reg });
  return startHttpServer(server.handler());
}

const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const reasoningOf = (text) => {
  let out = "";
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof data.choices?.[0]?.delta?.reasoning_content === "string") out += data.choices[0].delta.reasoning_content;
  }
  return out;
};

test("chat: the reference rides thinking and is not attached twice", async () => {
  const sink = {};
  const proxy = await startProxy(scriptedProvider(sink), flowless());
  try {
    const url = `${proxy.base}/v1/chat/completions`;
    const first = await (
      await post(url, { model: "gpt-5.5", stream: true, messages: [{ role: "user", content: "draw with @plugin:target" }] })
    ).text();

    const injected = sink.request.input.find((item) => item.role === "developer");
    assert.ok(injected, "the model is given the reference");
    assert.equal(injected.content, `<plugin-inject name="target">\n${LORE}\n</plugin-inject>`);

    const reasoning = reasoningOf(first);
    assert.match(reasoning, new RegExp(`<plugin-inject name="target">`), "the client is told, in thinking");

    // The client replays what it stored; the proxy must lift it, not attach it a second time.
    sink.request = null;
    await (
      await post(url, {
        model: "gpt-5.5",
        stream: true,
        messages: [
          { role: "user", content: "draw with @plugin:target" },
          { role: "assistant", content: "ok", reasoning_content: reasoning },
          { role: "user", content: "again" },
        ],
      })
    ).text();
    const developers = sink.request.input.filter((item) => item.role === "developer");
    assert.equal(developers.length, 1, "exactly the carried one, never a second injection");
    assert.match(developers[0].content, /Context carried over from earlier turns/);
  } finally {
    await proxy.close();
  }
});

test("a conversation can switch an off-by-default plugin back on", async () => {
  const sink = {};
  const reg = new ToolRegistry().register({
    name: "target",
    namespace: true,
    tools: [
      { name: "lookup", description: "look something up", parameters: { type: "object", properties: {} }, run: async () => "x" },
    ],
  });
  reg.setEnabled("target", false);
  const proxy = await startProxy(scriptedProvider(sink), reg);
  try {
    const text = await (
      await post(`${proxy.base}/v1/chat/completions`, {
        model: "gpt-5.5",
        stream: true,
        messages: [{ role: "user", content: "<enable_module>target</enable_module> look it up" }],
      })
    ).text();
    assert.ok(text.includes('"content":"ok"'));
    const tools = (sink.request.tools ?? []).map((tool) => tool.name);
    assert.ok(tools.includes("proxy_target_lookup"), `expected the tool back, got ${JSON.stringify(tools)}`);
    assert.ok(!JSON.stringify(sink.request).includes("enable_module"), "the control tag never reaches the model");
  } finally {
    await proxy.close();
  }
});

test("responses: a replayed carried block comes back as context", async () => {
  const sink = {};
  const proxy = await startProxy(scriptedProvider(sink), flowless());
  try {
    const url = `${proxy.base}/v1/responses`;
    await (await post(url, { model: "gpt-5.5", stream: true, input: "please @plugin:target" })).text();
    assert.ok(sink.request.input.some((item) => item.role === "developer" && item.content.includes(LORE)));

    sink.request = null;
    await (
      await post(url, {
        model: "gpt-5.5",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "please @plugin:target" }] },
          {
            type: "reasoning",
            content: [{ type: "reasoning_text", text: `<plugin-inject name="target">\n${LORE}\n</plugin-inject>` }],
          },
          { role: "user", content: [{ type: "input_text", text: "again" }] },
        ],
      })
    ).text();
    const developers = sink.request.input.filter((item) => item.role === "developer");
    assert.equal(developers.length, 1);
    assert.match(developers[0].content, new RegExp(`Context carried over from earlier turns:\n${LORE}`));
  } finally {
    await proxy.close();
  }
});

test("a mention and a switch match a plugin name case-insensitively", () => {
  const mentioned = applyModuleSwitches(input("@plugin:Docs"), ["docs"]);
  assert.ok(enabledModules(mentioned.switches, ["docs"]).has("docs"), "@plugin:Docs should enable docs");
  const switchedOff = applyModuleSwitches(input("<disable_module>Docs</disable_module>"), ["docs"]);
  assert.ok(switchedOff.disabled.has("docs"), "<disable_module>Docs should disable docs");
});
