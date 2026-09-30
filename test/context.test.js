import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextStore } from "../src/context-store.js";
import { ConversationContext, CONTEXT_TOOL, carryContext } from "../src/context.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { runAgent } from "../src/agent/loop.js";
import { Server } from "../src/server.js";
import { silentLog, startHttpServer } from "../test-support/helpers.js";

function history(marker) {
  return [
    { role: "user", content: "Read my document." },
    { type: "reasoning", content: [{ type: "reasoning_text", text: marker }] },
    { role: "assistant", content: "I read it." },
    { role: "user", content: "What was the exact number?" },
  ];
}

function evidence(input, source = "proxy_docs_read") {
  const calls = new Set(input.filter((i) => i?.name === source).map((i) => i.call_id));
  return input.filter((i) => i?.type === "function_call_output" && calls.has(i.call_id)).map((i) => i.output);
}

test("automatic evidence survives reasoning-only replay, with deterministic input and no history mutation", async () => {
  const store = new ContextStore();
  const first = new ConversationContext(store);
  await first.record("proxy_docs_read", '{"path":"/a"}', "Exact figure: 7291.");
  const marker = await first.marker();
  const original = history(marker);
  const before = structuredClone(original);
  const second = new ConversationContext(store);
  const restored = await second.restore(original);
  assert.deepEqual(evidence(restored), ["Exact figure: 7291."]);
  assert.deepEqual(original, before);
  assert.ok(!JSON.stringify(restored).includes("<proxy-context>"));
  assert.equal(restored.at(-1).content, "What was the exact number?");
  assert.equal(await second.marker(), marker, "ordinary follow-ups renew the same reference");
  assert.deepEqual(await new ConversationContext(store).restore(original), restored);
});

test("large evidence has exact paginated retrieval and media without re-running tools", async () => {
  const store = new ContextStore();
  const first = new ConversationContext(store);
  const source = "第一页甲乙丙\n".repeat(2500) + "FINAL_SOURCE_NUMBER_7291";
  const media = { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" };
  const output = [{ type: "input_text", text: source }, media];
  const entry = await first.record("proxy_docs_read", '{"page":1}', output);
  const shown = first.present(output, entry);
  assert.ok(JSON.stringify(shown).length < 4000);
  assert.match(shown[0].text, /Only an excerpt/);
  assert.deepEqual(shown[1], media);
  const second = new ConversationContext(store);
  const restored = await second.restore(history(await first.marker()));
  assert.deepEqual(evidence(restored), []);
  assert.ok(!JSON.stringify(restored).includes("FINAL_SOURCE_NUMBER_7291"));
  let recovered = "";
  let offset = 0;
  do {
    const part = JSON.parse(await second.read({ id: entry.id, offset, length: 3000 }));
    recovered += part.text;
    offset = part.next_offset;
  } while (offset !== null);
  assert.equal(recovered, source);
  assert.deepEqual((await second.read({ id: entry.id, media: 0 }))[1], media);
  await assert.rejects(second.read({ id: entry.id, offset: -1 }), /nonnegative/);
  await assert.rejects(second.read({ id: entry.id, length: 12001 }), /12000/);
  await assert.rejects(second.read({ id: entry.id, media: 1 }), /out of range/);
});

test("conversation branches, unrelated conversations, and user-supplied markers cannot share evidence implicitly", async () => {
  const store = new ContextStore();
  const parent = new ConversationContext(store);
  await parent.record("proxy_docs_read", "{}", "shared original");
  const marker = await parent.marker();
  const left = new ConversationContext(store);
  const right = new ConversationContext(store);
  await Promise.all([left.restore(history(marker)), right.restore(history(marker))]);
  const secret = await left.record("proxy_docs_read", "{}", "left-only evidence");
  await right.record("proxy_docs_read", "{}", "right-only evidence");
  assert.ok(!JSON.stringify(await new ConversationContext(store).restore(history(await right.marker()))).includes("left-only evidence"));
  assert.ok(!JSON.stringify(await new ConversationContext(store).restore(history(await left.marker()))).includes("right-only evidence"));
  await assert.rejects(right.read({ id: secret.id }), /not retained in this conversation/);
  const unrelated = new ConversationContext(store);
  await unrelated.restore([{ role: "user", content: marker }]);
  assert.equal(unrelated.records.length, 0);
  await assert.rejects(unrelated.read({ id: secret.id }), /not retained/);
});

test("only the latest cumulative snapshot is needed after client history compaction", async () => {
  const store = new ContextStore();
  const first = new ConversationContext(store);
  await first.record("proxy_docs_read", "{}", "first file");
  const second = new ConversationContext(store);
  await second.restore(history(await first.marker()));
  await second.record("proxy_search_read", "{}", "second file");
  const restored = await new ConversationContext(store).restore(history(await second.marker()).slice(1));
  assert.deepEqual(evidence(restored), ["first file"]);
  assert.deepEqual(evidence(restored, "proxy_search_read"), ["second file"]);
});

test("disk persistence restores original evidence after a new store is constructed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-context-"));
  try {
    const first = new ConversationContext(new ContextStore({ directory }));
    await first.record("proxy_docs_read", "{}", "survives restart");
    const marker = await first.marker();
    const next = new ConversationContext(new ContextStore({ directory }));
    assert.deepEqual(evidence(await next.restore(history(marker))), ["survives restart"]);
    const files = await readdir(directory);
    assert.equal(files.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evicted or corrupt evidence is explicitly unavailable and never invented", async () => {
  const store = new ContextStore({ maxEntries: 2 });
  const first = new ConversationContext(store);
  const entry = await first.record("proxy_docs_read", "{}", "evict me");
  const marker = await first.marker();
  await store.put({ unrelated: true });
  const next = new ConversationContext(store);
  await next.restore(history(marker));
  await assert.rejects(next.read({ id: entry.id }), /original result unavailable/);
  const empty = new ConversationContext(new ContextStore());
  const restored = await empty.restore(history(marker));
  assert.match(JSON.stringify(restored), /reference is unavailable/);
  assert.equal(await empty.marker(), marker, "keep reporting loss on later turns");
  assert.equal(await store.get("../../anything"), null);
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-context-corrupt-"));
  try {
    const disk = new ContextStore({ directory });
    const id = await disk.put({ evidence: "original" });
    await writeFile(path.join(directory, `${id}.json`), '{"evidence":"tampered"}');
    assert.equal(await disk.get(id), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded replay advertises dropped and oversized records instead of claiming complete memory", async () => {
  const store = new ContextStore();
  const context = new ConversationContext(store);
  for (let i = 0; i < 140; i++) await context.record("proxy_docs_read", JSON.stringify({ page: i }), "x".repeat(7900));
  const next = new ConversationContext(store);
  const input = await next.restore(history(await context.marker()));
  assert.equal(next.records.length, 128);
  assert.match(next.catalog(), /12 older or oversized/);
  assert.ok(evidence(input).join("").length <= 32000);
  const small = new ConversationContext(new ContextStore({ maxBytes: 1000 }));
  await small.record("proxy_docs_read", "{}", "x".repeat(2000));
  const lost = new ConversationContext(small.store);
  assert.match(JSON.stringify(await lost.restore(history(await small.marker()))), /1 older or oversized/);
});

const toolEvent = (name, args = {}) => ({ type: "response.output_item.done", data: { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name, arguments: JSON.stringify(args) } } });
const completed = () => ({ type: "response.completed", data: { type: "response.completed", response: { id: "resp_test", status: "completed" } } });
async function* answer(text) {
  yield { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: text } };
  yield { type: "response.output_item.done", data: { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } } };
  yield completed();
}

test("core loop automatically records arbitrary plugins, failures and manual opt-out", async () => {
  for (const manual of [false, true]) {
    const context = new ConversationContext(new ContextStore());
    const registry = new ToolRegistry().register({ name: "any_plugin", context: manual ? "manual" : "auto", tools: [{ name: "lookup", run: async () => { throw new Error("source unreadable"); } }] });
    let turn = 0;
    const stream = async function* () {
      if (turn++ === 0) { yield toolEvent("proxy_any_plugin_lookup"); yield completed(); }
      else yield* answer("Source unavailable.");
    };
    const events = [];
    for await (const event of carryContext(runAgent({ stream, request: { input: [] }, registry, context }), context)) events.push(event);
    assert.equal(context.records.length, manual ? 0 : 1);
    if (!manual) assert.match(await context.read({ id: context.records[0].id }), /source unreadable/);
  }
});

test("core retrieval does not execute the plugin again or create recursive archives", async () => {
  const context = new ConversationContext(new ContextStore());
  const entry = await context.record("proxy_docs_read", "{}", "original result");
  let turn = 0;
  const payloads = [];
  const stream = async function* (payload) {
    payloads.push(payload);
    if (turn++ === 0) { yield toolEvent(CONTEXT_TOOL, { id: entry.id }); yield completed(); }
    else yield* answer("done");
  };
  for await (const _ of runAgent({ stream, request: { input: [] }, registry: null, context })) { /* consume */ }
  assert.equal(context.records.length, 1);
  assert.match(JSON.stringify(payloads[1].input), /original result/);
});

test("a client tool with the same name remains client-owned", async () => {
  let called = false;
  const registry = new ToolRegistry().register({ name: "docs", tools: [{ name: "read", run: async () => { called = true; } }] });
  const stream = async function* () { yield toolEvent("proxy_docs_read"); yield completed(); };
  const events = [];
  for await (const event of runAgent({ stream, request: { input: [], tools: [{ type: "function", name: "proxy_docs_read" }] }, registry })) events.push(event);
  assert.equal(called, false);
  assert.ok(events.some((e) => e.data?.item?.name === "proxy_docs_read"));
});

test("local evidence survives a mixed client/local batch and an upstream failure after a tool", async () => {
  for (const mixed of [true, false]) {
    const context = new ConversationContext(new ContextStore());
    let executions = 0;
    const registry = new ToolRegistry().register({ name: "docs", tools: [{ name: "read", run: async () => { executions++; return "already read"; } }] });
    let turn = 0;
    const stream = async function* () {
      if (turn++ > 0) throw new Error("upstream disconnected");
      yield { type: "response.output_item.added", data: { type: "response.output_item.added", item: { type: "function_call", id: "local1", name: "proxy_docs_read" } } };
      yield { type: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", item_id: "local1", delta: "{}" } };
      yield toolEvent("proxy_docs_read");
      if (mixed) yield toolEvent("client_lookup");
      yield completed();
    };
    const events = [];
    const consume = async () => {
      for await (const e of carryContext(runAgent({ stream, request: { input: [] }, registry, context }), context)) events.push(e);
    };
    if (mixed) await consume();
    else await assert.rejects(consume(), /upstream disconnected/);
    assert.equal(executions, 1);
    assert.ok(!events.some((e) => e.data?.item?.name === "proxy_docs_read"));
    assert.ok(!events.some((e) => e.type === "response.function_call_arguments.delta"));
    const marker = events.find((e) => e.type === "response.output_item.done" && e.data.item.type === "reasoning").data.item.summary[0].text;
    assert.deepEqual(evidence(await new ConversationContext(context.store).restore(history(marker))), ["already read"]);
  }
});

test("inserted thinking items cannot collide with upstream output indexes", async () => {
  const context = new ConversationContext(new ContextStore());
  await context.record("proxy_docs_read", "{}", "source");
  const events = async function* () {
    yield { type: "codex_proxy.context_saved", data: {} };
    yield { type: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_answer", role: "assistant", content: [] } } };
    yield { type: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: "msg_answer", output_index: 0, delta: "answer" } };
    yield { type: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_answer", role: "assistant", content: [{ type: "output_text", text: "answer" }] } } };
    yield completed();
  };
  const output = [];
  for await (const event of carryContext(events(), context)) output.push(event);
  const done = output.filter((e) => e.type === "response.output_item.done");
  assert.deepEqual(done.map((e) => e.data.output_index), [0, 1]);
  assert.equal(output.find((e) => e.type === "response.output_text.delta").data.output_index, 1);
  assert.deepEqual(output.at(-1).data.response.output, done.map((e) => e.data.item));
});

test("attachment ingestion and plain plugin contributions need no plugin-side memory code", async () => {
  const payloads = [];
  const registry = new ToolRegistry().register({
    name: "custom",
    ingestFile: async () => "ATTACHMENT_SOURCE_7291",
    contribute: ({ input }) => input.some((i) => i?.role === "user" && JSON.stringify(i.content).includes("attach-reference"))
      ? { append: [{ role: "developer", content: "PLUGIN_REFERENCE_8152" }] } : null,
  });
  const provider = { events: async function* (payload) { payloads.push(payload); yield* answer("read"); } };
  const server = new Server({ provider, registry, log: silentLog, keepaliveMs: 0 });
  const http = await startHttpServer(server.handler());
  const post = async (messages) => {
    const response = await fetch(`${http.base}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "test", messages }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const first = await post([{ role: "user", content: [
      { type: "text", text: "attach-reference" },
      { type: "file", file: { filename: "a.txt", file_data: "data:text/plain;base64,YQ==" } },
    ] }]);
    const message = first.choices[0].message;
    assert.match(message.reasoning_content, /proxy-context/);
    await post([message, { role: "user", content: "Continue without the original attachment or trigger." }]);
    assert.deepEqual(evidence(payloads.at(-1).input, "proxy_attachment_ingest"), ["ATTACHMENT_SOURCE_7291"]);
    assert.match(JSON.stringify(payloads.at(-1).input), /PLUGIN_REFERENCE_8152/);
  } finally {
    await http.close();
  }
});

// Real HTTP round trips test what a client can actually retain, not only internal helpers.
for (const api of ["chat", "responses"]) for (const streaming of [false, true]) {
  test(`${api}, stream=${streaming}: source returns on the next request solely through thinking`, async () => {
    let turn = 0;
    let executions = 0;
    const payloads = [];
    const provider = { events: async function* (payload) {
      payloads.push(structuredClone(payload));
      if (turn++ === 0) { yield toolEvent("proxy_docs_read"); yield completed(); }
      else yield* answer("The document was read.");
    } };
    const registry = new ToolRegistry().register({ name: "docs", tools: [{ name: "read", run: async () => { executions++; return "PRIVATE_SOURCE_7291"; } }] });
    const server = new Server({ provider, registry, log: silentLog, keepaliveMs: 0 });
    const http = await startHttpServer(server.handler());
    const post = async (body) => fetch(`${http.base}/v1/${api === "chat" ? "chat/completions" : "responses"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "test", ...body }) });
    try {
      const initial = api === "chat" ? { messages: [{ role: "user", content: "Read file." }] } : { input: [{ role: "user", content: "Read file." }] };
      const response = await post({ ...initial, stream: streaming });
      assert.equal(response.status, 200);
      let thinking;
      let content;
      let output;
      if (!streaming) {
        const body = await response.json();
        if (api === "chat") {
          thinking = body.choices[0].message.reasoning_content;
          content = body.choices[0].message.content;
        } else output = body.output;
      } else {
        const text = await response.text();
        const events = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
        if (api === "chat") {
          thinking = events.map((e) => e.choices?.[0]?.delta?.reasoning_content ?? "").join("");
          content = events.map((e) => e.choices?.[0]?.delta?.content ?? "").join("");
        } else {
          output = events.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
          const final = events.find((e) => e.type === "response.completed");
          assert.ok(final.response.output.some((item) => item.type === "reasoning"));
        }
      }
      if (api === "responses") {
        thinking = output.filter((i) => i.type === "reasoning").flatMap((i) => i.summary ?? []).map((p) => p.text).join("");
        content = output.filter((i) => i.type === "message").flatMap((i) => i.content).map((p) => p.text).join("");
      }
      assert.match(thinking, /<proxy-context>[a-f0-9]{64}<\/proxy-context>/);
      assert.match(thinking, /\n<proxy-context>[a-f0-9]{64}<\/proxy-context>\n/, "the marker is newline-framed");
      assert.ok(!content.includes("<proxy-context>"), "no marker in the answer body");
      assert.ok(!thinking.includes("PRIVATE_SOURCE_7291"), "only a capability, not the file, travels to the client");
      const next = api === "chat"
        ? { messages: [{ role: "assistant", content, reasoning_content: thinking }, { role: "user", content: "What number?" }] }
        : { input: [...output, { role: "user", content: "What number?" }] };
      const again = await post(next);
      assert.equal(again.status, 200);
      const nextBody = await again.json();
      assert.deepEqual(evidence(payloads.at(-1).input), ["PRIVATE_SOURCE_7291"]);
      assert.equal(executions, 1);
      assert.ok(!JSON.stringify(payloads.at(-1)).includes("<proxy-context>"));
      assert.match(JSON.stringify(nextBody), /proxy-context/, "the latest reply renews context even without a new tool call");
    } finally {
      await http.close();
    }
  });
}

test("replayed evidence stays in front of the answer that used it, so later requests share the prefix", async () => {
  const store = new ContextStore();
  const first = new ConversationContext(store);
  await first.record("proxy_docs_read", '{"page":1}', "page one");
  const one = await first.marker();
  const turn2 = [
    { role: "user", content: "Read page one." },
    { type: "reasoning", content: [{ type: "reasoning_text", text: one }] },
    { role: "assistant", content: "Page one says hello." },
    { role: "user", content: "Now page two." },
  ];
  const second = new ConversationContext(store);
  const sent2 = await second.restore(turn2);
  await second.record("proxy_docs_read", '{"page":2}', "page two");
  const two = await second.marker();
  const turn3 = [...turn2,
    { type: "reasoning", content: [{ type: "reasoning_text", text: two }] },
    { role: "assistant", content: "Page two says goodbye." },
    { role: "user", content: "Compare them." }];
  const sent3 = await new ConversationContext(store).restore(turn3);

  const catalog = (items) => new Set(items.filter((i) => i.call_id?.startsWith("ctx_index_")).map((i) => i.call_id));
  const stable = (items) => { const skip = catalog(items); return items.filter((i) => !skip.has(i.call_id)); };
  assert.deepEqual(stable(sent3).slice(0, stable(sent2).length), stable(sent2));
  const at = (items, text) => items.findIndex((i) => i.output === text || i.content === text);
  assert.ok(at(sent3, "page one") < at(sent3, "Page one says hello."));
  assert.ok(at(sent3, "Now page two.") < at(sent3, "page two"));
  assert.ok(at(sent3, "page two") < at(sent3, "Page two says goodbye."));
  assert.equal(sent3.at(-1).content, "Compare them.");
});
