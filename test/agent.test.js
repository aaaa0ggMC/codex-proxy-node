import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, normalizeToolResult } from "../src/agent/tools.js";
import { mergeTools, runAgent } from "../src/agent/loop.js";
import { ContextStore } from "../src/context-store.js";
import { ConversationContext } from "../src/context.js";

const textTurn = (text) => [
  { type: "response.output_text.delta", data: { delta: text } },
  { type: "response.completed", data: { response: { id: "resp_1", status: "completed" } } },
];

const toolTurn = (name, args, callId) => [
  {
    type: "response.output_item.done",
    data: { item: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) } },
  },
  { type: "response.completed", data: { response: { id: "resp_tool", status: "completed" } } },
];

// scripted returns a stream function that replays one event list per turn, recording the payloads
// it was asked to send so a test can inspect what the loop fed back.
function scripted(turns) {
  const payloads = [];
  let turn = 0;
  return {
    payloads,
    stream: async (payload) => {
      payloads.push(payload);
      const events = turns[Math.min(turn, turns.length - 1)];
      turn += 1;
      return (async function* replay() {
        for (const event of events) yield event;
      })();
    },
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function docsPlugin(result) {
  return {
    name: "docs",
    tools: [
      {
        name: "read_page",
        description: "read a page",
        parameters: { type: "object", properties: { page: { type: "number" } } },
        run: async (args) => result(args),
      },
    ],
  };
}

test("mergeTools lets a client-owned tool win over a plugin tool", () => {
  const merged = mergeTools([{ type: "function", name: "proxy_docs_read_page" }], [
    { type: "function", name: "proxy_docs_read_page" },
    { type: "function", name: "docs_search" },
  ]);
  assert.deepEqual(merged.map((t) => t.name), ["proxy_docs_read_page", "docs_search"]);
  assert.equal(merged.length, 2, "the client tool is not duplicated");
});

test("runAgent passes events straight through when there are no local tools", async () => {
  const fake = scripted([textTurn("pong")]);
  const events = await collect(
    runAgent({ stream: fake.stream, request: { input: [], tools: undefined }, registry: null }),
  );
  assert.deepEqual(events.map((e) => e.type), ["response.output_text.delta", "response.completed"]);
  assert.equal(fake.payloads.length, 1, "no second turn without a local tool call");
});

test("runAgent runs a local tool, feeds the result back, and hides the call", async () => {
  const fake = scripted([toolTurn("proxy_docs_read_page", { page: 2 }, "call_1"), textTurn("slide two is blue")]);
  const registry = new ToolRegistry().register(
    docsPlugin((args) => [
      { type: "input_text", text: `page ${args.page}` },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    ]),
  );

  const events = await collect(runAgent({ stream: fake.stream, request: { input: [], tools: undefined }, registry }));

  assert.deepEqual(events.map((e) => e.type), [
    "codex_proxy.tool_start",
    "response.output_text.delta",
    "response.completed",
  ]);
  assert.equal(events[0].data.name, "proxy_docs_read_page", "the caller is told a local tool is running");
  assert.ok(
    !events.some((e) => e.data?.item?.type === "function_call"),
    "a local tool call must never reach the client",
  );

  assert.equal(fake.payloads.length, 2, "the loop must make a second turn");
  const replay = fake.payloads[1].input;
  assert.deepEqual(replay[0], { type: "function_call", call_id: "call_1", name: "proxy_docs_read_page", arguments: '{"page":2}' });
  const parts = replay[1].output;
  assert.deepEqual(parts.slice(0, 2), [
    { type: "input_text", text: "page 2" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  ]);
  assert.match(parts[2].text, /^\[image handle: img_[a-f0-9]+ —/, "the model is given a handle for the image");

  const declarations = fake.payloads[0].tools.map((t) => t.name);
  assert.deepEqual(declarations, ["proxy_docs_read_page"]);
});

test("runAgent hands a client-owned tool call back instead of running it", async () => {
  const fake = scripted([toolTurn("client_lookup", { q: "x" }, "call_9")]);
  const registry = new ToolRegistry().register(docsPlugin(() => "never"));

  const events = await collect(runAgent({ stream: fake.stream, request: { input: [] }, registry }));

  // The client sees both its tool call and the completion, and then gets to run the tool itself.
  assert.deepEqual(events.map((e) => e.type), ["response.output_item.done", "response.completed"]);
  assert.equal(events[0].data.item.name, "client_lookup");
  assert.equal(fake.payloads.length, 1, "the loop must end and let the client run its tool");
});

test("runAgent tells the model when a local tool fails", async () => {
  const fake = scripted([
    toolTurn("proxy_docs_read_page", { page: 99 }, "call_2"),
    textTurn("that page does not exist"),
  ]);
  const registry = new ToolRegistry().register(
    docsPlugin(() => {
      throw new Error("no such page");
    }),
  );

  await collect(runAgent({ stream: fake.stream, request: { input: [] }, registry }));

  assert.deepEqual(fake.payloads[1].input[1].output, "Tool proxy_docs_read_page failed: no such page");
});

test("runAgent stops at maxTurns", async () => {
  const fake = scripted([toolTurn("proxy_docs_read_page", { page: 1 }, "call_x")]);
  const registry = new ToolRegistry().register(docsPlugin(() => "ok"));
  await collect(runAgent({ stream: fake.stream, request: { input: [] }, registry, maxTurns: 3 }));
  assert.equal(fake.payloads.length, 3);
});

test("ToolRegistry refuses duplicates and forward references", () => {
  const registry = new ToolRegistry().register(docsPlugin(() => "x"));
  assert.throws(() => registry.register(docsPlugin(() => "y")), /duplicate tool/);
  assert.throws(() => registry.register({ name: "bad", tools: [{ name: "t" }] }), /has no run/);
});

test("ToolRegistry parses JSON arguments and normalises results", async () => {
  const seen = [];
  const registry = new ToolRegistry().register({
    name: "t",
    tools: [{ name: "echo", run: async (args) => (seen.push(args), { got: args.n }) }],
  });

  assert.equal(await registry.call("proxy_t_echo", '{"n":3}'), '{"got":3}');
  assert.deepEqual(seen, [{ n: 3 }]);
  await assert.rejects(registry.call("proxy_t_echo", "{oops"), /not JSON/);
  await assert.rejects(registry.call("missing", "{}"), /unknown tool/);
});

test("normalizeToolResult accepts the three content part kinds only", () => {
  assert.equal(normalizeToolResult(null), "");
  assert.equal(normalizeToolResult(7), "7");
  assert.deepEqual(normalizeToolResult([{ type: "input_image", image_url: "u" }]), [
    { type: "input_image", image_url: "u" },
  ]);
  assert.throws(() => normalizeToolResult([{ type: "text" }]), /must be input_text, input_image or input_audio/);
});

test("a carried block in a tool result reaches thinking but is stripped before the model sees it", async () => {
  const fake = scripted([
    toolTurn("proxy_checkpoint_save", { text: "note" }, "call_cp"),
    textTurn("ok"),
  ]);
  const registry = new ToolRegistry().register({
    name: "checkpoint",
    tools: [
      {
        name: "save",
        parameters: { type: "object", properties: { text: { type: "string" } } },
        run: async () => "Saved.\n<checkpoint>note</checkpoint>",
      },
    ],
  });

  const events = await collect(runAgent({ stream: fake.stream, request: { input: [] }, registry }));
  const checkpointEvent = events.find((e) => e.type === "codex_proxy.checkpoint");
  assert.deepEqual(checkpointEvent.data.blocks, ["note"], "the block still rides the thinking channel");

  const fedBack = fake.payloads[1].input.find((i) => i.type === "function_call_output");
  assert.equal(fedBack.output, "Saved.", "only the human-readable part is fed back");
  assert.ok(!JSON.stringify(fake.payloads[1].input).includes("<checkpoint>"), "no proxy markup reaches the model");
});

test("a checkpoint never comes back to the model as markup, on the same turn or on replay", async () => {
  const store = new ContextStore();
  const context = new ConversationContext(store);
  const payloads = [];
  let turn = 0;
  const stream = async (payload) => {
    payloads.push(structuredClone(payload));
    const events = turn++ === 0
      ? [
          { type: "response.output_item.done", data: { item: { type: "function_call", call_id: "call_cp", name: "proxy_checkpoint_save", arguments: '{"text":"deck = /d/a.pptx"}' } } },
          { type: "response.completed", data: { response: { id: "r1", status: "completed" } } },
        ]
      : [
          { type: "response.output_text.delta", data: { delta: "ok" } },
          { type: "response.completed", data: { response: { id: "r2", status: "completed" } } },
        ];
    return (async function* replay() { for (const event of events) yield event; })();
  };
  const registry = new ToolRegistry().register({
    name: "checkpoint",
    tools: [{ name: "save", parameters: {}, run: async () => "Saved.\n<checkpoint>deck = /d/a.pptx</checkpoint>" }],
  });

  await collect(runAgent({ stream, request: { input: [{ role: "user", content: "remember" }] }, registry, context }));
  assert.ok(!JSON.stringify(payloads[1].input).includes("<checkpoint>"), "same-turn feedback is clean");

  const marker = await context.marker();
  const replayed = await new ConversationContext(store).restore([{ role: "assistant", content: marker }]);
  assert.ok(!JSON.stringify(replayed).includes("<checkpoint>"), "restored evidence is clean");
  assert.ok(JSON.stringify(replayed).includes("deck = /d/a.pptx"), "but the note itself still survives");
});

test("usage is summed across the turns of one request, not taken from the last one", async () => {
  const usageTurn = (callId, usage) => [
    { type: "response.output_item.done", data: { item: { type: "function_call", call_id: callId, name: "proxy_docs_read", arguments: "{}" } } },
    { type: "response.completed", data: { response: { id: `r_${callId}`, status: "completed", usage } } },
  ];
  const finalTurn = (usage) => [
    { type: "response.output_text.delta", data: { delta: "done" } },
    { type: "response.completed", data: { response: { id: "r_final", status: "completed", usage } } },
  ];
  const fake = scripted([
    usageTurn("c1", { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 2 } }),
    finalTurn({ input_tokens: 300, output_tokens: 20, total_tokens: 320, input_tokens_details: { cached_tokens: 250 }, output_tokens_details: { reasoning_tokens: 5 } }),
  ]);
  const registry = new ToolRegistry().register({ name: "docs", tools: [{ name: "read", parameters: {}, run: async () => "x" }] });

  const events = await collect(runAgent({ stream: fake.stream, request: { input: [] }, registry }));
  const completed = events.find((event) => event.type === "response.completed");
  assert.deepEqual(completed.data.response.usage, {
    input_tokens: 400,
    output_tokens: 30,
    total_tokens: 430,
    input_tokens_details: { cached_tokens: 290 },
    output_tokens_details: { reasoning_tokens: 7 },
  });
});

test("a tool's progress is streamed while it runs, not only after it returns", async () => {
  const fake = scripted([toolTurn("proxy_slow_work", {}, "c1"), textTurn("ok")]);
  const registry = new ToolRegistry().register({
    name: "slow",
    tools: [
      {
        name: "work",
        parameters: {},
        run: async (_args, ctx) => {
          ctx.progress("rendering with LibreOffice");
          ctx.progress("halfway");
          return "done";
        },
      },
    ],
  });

  const events = await collect(runAgent({ stream: fake.stream, request: { input: [] }, registry }));
  const progress = events.filter((event) => event.type === "codex_proxy.progress").map((event) => event.data.text);
  assert.deepEqual(progress, ["rendering with LibreOffice", "halfway"]);
});
