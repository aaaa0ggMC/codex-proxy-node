import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/agent/tools.js";
import { FenceRewriter, restoreResponseInput, transformEvents, withLeadingInjection } from "../src/transforms.js";
import { buildResponsesRequestFromChat } from "../src/compat.js";

const render = (language, source) => (language === "mermaid" ? `[drawn ${source.trim()}]` : null);
const rewriter = () => new FenceRewriter({ languages: new Set(["mermaid"]), render });

test("FenceRewriter passes ordinary text straight through", () => {
  const out = rewriter();
  assert.deepEqual(out.feed("hello\nworld\n"), { text: "hello\nworld\n", notes: [] });
  assert.deepEqual(out.flush(), { text: "", notes: [] });
});

test("FenceRewriter buffers a claimed fence across chunk boundaries", () => {
  const out = rewriter();
  assert.equal(out.feed("before\n``").text, "before\n", "an incomplete opener must be held back");
  assert.equal(out.feed("`mermaid\nA-->B\n").text, "");
  const closed = out.feed("```\nafter\n");
  assert.equal(closed.text, "[drawn A-->B]\nafter\n");
  assert.deepEqual(closed.notes, [{ language: "mermaid", source: "A-->B" }]);
});

test("FenceRewriter leaves an unclaimed language alone", () => {
  const out = rewriter();
  assert.equal(out.feed("```python\nprint(1)\n```\n").text, "```python\nprint(1)\n```\n");
});

test("FenceRewriter hands back an unterminated fence verbatim", () => {
  const out = rewriter();
  out.feed("```mermaid\nA-->B");
  assert.equal(out.flush().text, "```mermaid\nA-->B");
});

test("FenceRewriter keeps a declined render as the original fence", () => {
  const out = new FenceRewriter({ languages: new Set(["mermaid"]), render: () => null });
  assert.equal(out.feed("```mermaid\nA-->B\n```\n").text, "```mermaid\nA-->B\n```\n");
});

function registryWith(plugin) {
  return new ToolRegistry().register(plugin);
}

test("the registry exposes fence languages, rendering and restore", () => {
  const registry = registryWith({
    name: "flowchart",
    instructions: "draw diagrams",
    fences: { mermaid: (source) => `[${source}]` },
    restoreText: (text) => text.replace("[A]", "```mermaid\nA\n```"),
  });

  assert.deepEqual([...registry.fenceLanguages()], ["mermaid"]);
  assert.equal(registry.renderFence("mermaid", "A"), "[A]");
  assert.equal(registry.renderFence("graphviz", "A"), null);
  assert.deepEqual(registry.instructions(), ["draw diagrams"]);
  assert.equal(registry.restore("see [A] here"), "see ```mermaid\nA\n``` here");
  assert.equal(registry.hasTransforms(), true);
});

test("a disabled plugin contributes neither fences nor instructions", () => {
  const registry = registryWith({
    name: "flowchart",
    instructions: "draw",
    fences: { mermaid: (source) => `[${source}]` },
  });
  registry.setEnabled("flowchart", false);
  assert.equal(registry.fenceLanguages().size, 0);
  assert.deepEqual(registry.instructions(), []);
  assert.equal(registry.renderFence("mermaid", "A"), null);
});

test("include switches an off-by-default plugin back on for one request", () => {
  const registry = new ToolRegistry().register({
    name: "docs",
    namespace: true,
    instructions: "read docs",
    fences: { mermaid: () => "[x]" },
    tools: [{ name: "open", parameters: { type: "object", properties: {} }, run: async () => "" }],
  });
  registry.setEnabled("docs", false);

  assert.equal(registry.definitions().length, 0, "off by default");
  assert.deepEqual(registry.instructions(), []);
  assert.equal(registry.fenceLanguages().size, 0);

  const on = { exclude: [], include: ["docs"] };
  assert.equal(registry.definitions(on).length, 1);
  assert.deepEqual(registry.instructions(on), ["read docs"]);
  assert.deepEqual([...registry.fenceLanguages(on)], ["mermaid"]);

  // A conversation that switched it off still wins over the opt-in.
  assert.equal(registry.definitions({ exclude: ["docs"], include: ["docs"] }).length, 0);
});

test("a tool-less plugin still has a name to toggle", () => {
  const registry = registryWith({ name: "flowchart", fences: { mermaid: () => "[x]" } });
  assert.deepEqual(registry.pluginNames(), ["flowchart"]);
});

async function* stream(events) {
  for (const event of events) yield event;
}

async function collect(events, registry) {
  const out = [];
  for await (const event of transformEvents(events, { registry })) out.push(event);
  return out;
}

test("transformEvents rewrites deltas and carries the source on the thinking channel", async () => {
  const registry = registryWith({ name: "flowchart", fences: { mermaid: (source) => `[${source}]` } });
  const events = [
    { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Here:\n" } },
    { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "```mermaid\nA-->B\n" } },
    { type: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "```\nDone\n" } },
    {
      type: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Here:\n```mermaid\nA-->B\n```\nDone\n" }] },
      },
    },
  ];

  const out = await collect(stream(events), registry);
  const text = out.filter((e) => e.type === "response.output_text.delta").map((e) => e.data.delta).join("");
  assert.equal(text, "Here:\n[A-->B]\nDone\n");

  const notes = out.filter((e) => e.type === "response.reasoning_text.delta").map((e) => e.data.delta);
  assert.deepEqual(notes, ['\n<plugin-fence name="mermaid">\nA-->B\n</plugin-fence>\n'], "framed so it cannot run into adjacent thinking");

  const item = out.find((e) => e.type === "response.output_item.done").data.item;
  assert.equal(item.content[0].text, "Here:\n[A-->B]\nDone\n");
});

test("transformEvents rewrites a finished item when no deltas were sent", async () => {
  const registry = registryWith({ name: "flowchart", fences: { mermaid: (source) => `[${source}]` } });
  const events = [
    {
      type: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "```mermaid\nA-->B\n```" }] },
      },
    },
  ];
  const out = await collect(stream(events), registry);
  const item = out.find((e) => e.type === "response.output_item.done").data.item;
  assert.equal(item.content[0].text, "[A-->B]");
});

test("restoreResponseInput restores assistant text and strips reasoning notes", () => {
  const registry = registryWith({
    name: "flowchart",
    restoreText: (text) => text.replace("[drawn]", "```mermaid\nA\n```"),
  });
  const input = [
    { role: "user", content: [{ type: "input_text", text: "[drawn]" }] },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking <ignore>proxy note</ignore>" }] },
    { role: "assistant", content: [{ type: "output_text", text: "see [drawn] now" }] },
  ];
  restoreResponseInput(input, { registry });
  assert.equal(input[0].content[0].text, "[drawn]", "user text is not ours to rewrite");
  assert.equal(input[1].content[0].text, "thinking");
  assert.equal(input[2].content[0].text, "see ```mermaid\nA\n``` now");
});

test("buildResponsesRequestFromChat restores a replayed diagram", () => {
  const restoreText = (text) => text.replace("[drawn]", "```mermaid\nA-->B\n```");
  const { request } = buildResponsesRequestFromChat(
    {
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "draw it" },
        { role: "assistant", content: "here [drawn]" },
        { role: "user", content: "again" },
      ],
    },
    { restoreText },
  );
  const assistant = request.input.find((item) => item.role === "assistant");
  assert.equal(assistant.content, "here ```mermaid\nA-->B\n```");
});

test("proxy reasoning blocks are newline-framed so they never run into adjacent thinking", async () => {
  const events = (async function* () {
    yield { type: "response.reasoning_text.delta", data: { type: "response.reasoning_text.delta", delta: "The user wants a file" } };
  })();
  const carried = '<plugin-inject name="docs">\nref\n</plugin-inject>';
  const out = [];
  for await (const event of withLeadingInjection({ carried: [carried], notes: ["proxy_filesearch_search(q)"] }, events)) out.push(event);
  const reasoning = out.filter((e) => e.type === "response.reasoning_text.delta").map((e) => e.data.delta).join("");

  assert.ok(!reasoning.includes("</plugin-inject>The user"), "the carried block must not touch the model text");
  assert.ok(!reasoning.includes("</ignore>The user"), "the note must not touch the model text");
  assert.match(reasoning, /\n<plugin-inject name="docs">\nref\n<\/plugin-inject>\n/);
  assert.match(reasoning, /\n<ignore>proxy_filesearch_search\(q\)<\/ignore>\n/);
  assert.ok(reasoning.endsWith("The user wants a file"));
});
