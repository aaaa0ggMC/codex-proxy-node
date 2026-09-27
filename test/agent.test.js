import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, normalizeToolResult } from "../src/agent/tools.js";
import { mergeTools, runAgent } from "../src/agent/loop.js";

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
        name: "docs_read_page",
        description: "read a page",
        parameters: { type: "object", properties: { page: { type: "number" } } },
        run: async (args) => result(args),
      },
    ],
  };
}

test("mergeTools lets a client-owned tool win over a plugin tool", () => {
  const merged = mergeTools([{ type: "function", name: "docs_read_page" }], [
    { type: "function", name: "docs_read_page" },
    { type: "function", name: "docs_search" },
  ]);
  assert.deepEqual(merged.map((t) => t.name), ["docs_read_page", "docs_search"]);
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
  const fake = scripted([toolTurn("docs_read_page", { page: 2 }, "call_1"), textTurn("slide two is blue")]);
  const registry = new ToolRegistry().register(
    docsPlugin((args) => [
      { type: "input_text", text: `page ${args.page}` },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    ]),
  );

  const events = await collect(runAgent({ stream: fake.stream, request: { input: [], tools: undefined }, registry }));

  assert.deepEqual(events.map((e) => e.type), [
    "response.output_text.delta",
    "response.completed",
  ]);
  assert.ok(
    !events.some((e) => e.data?.item?.type === "function_call"),
    "a local tool call must never reach the client",
  );

  assert.equal(fake.payloads.length, 2, "the loop must make a second turn");
  const replay = fake.payloads[1].input;
  assert.deepEqual(replay[0], { type: "function_call", call_id: "call_1", name: "docs_read_page", arguments: '{"page":2}' });
  assert.deepEqual(replay[1].output, [
    { type: "input_text", text: "page 2" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  ]);

  const declarations = fake.payloads[0].tools.map((t) => t.name);
  assert.deepEqual(declarations, ["docs_read_page"]);
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
    toolTurn("docs_read_page", { page: 99 }, "call_2"),
    textTurn("that page does not exist"),
  ]);
  const registry = new ToolRegistry().register(
    docsPlugin(() => {
      throw new Error("no such page");
    }),
  );

  await collect(runAgent({ stream: fake.stream, request: { input: [] }, registry }));

  assert.deepEqual(fake.payloads[1].input[1].output, "Tool docs_read_page failed: no such page");
});

test("runAgent stops at maxTurns", async () => {
  const fake = scripted([toolTurn("docs_read_page", { page: 1 }, "call_x")]);
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

  assert.equal(await registry.call("echo", '{"n":3}'), '{"got":3}');
  assert.deepEqual(seen, [{ n: 3 }]);
  await assert.rejects(registry.call("echo", "{oops"), /not JSON/);
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
