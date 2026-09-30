import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "../src/server.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { silentLog, startHttpServer } from "../test-support/helpers.js";
import flowchart from "../plugins/flowchart/index.js";

// End-to-end through the real SSE transports: a diagram must come out rendered on both endpoints,
// and go back in as the source it came from.

const MERMAID = "flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]";

function scriptedProvider(events, sink = {}) {
  return {
    async *events(request) {
      sink.request = request;
      for (const event of events) yield event;
    },
    async models() {
      return [];
    },
    async usage() {
      return null;
    },
  };
}

function diagramEvents() {
  const text = `Here is the flow:\n\`\`\`mermaid\n${MERMAID}\n\`\`\`\n`;
  return [
    { type: "response.output_text.delta", data: { delta: "Here is the flow:\n" } },
    { type: "response.output_text.delta", data: { delta: `\`\`\`mermaid\n${MERMAID}\n` } },
    { type: "response.output_text.delta", data: { delta: "```\n" } },
    { type: "response.output_item.done", data: { item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } } },
    { type: "response.completed", data: { response: { id: "r", status: "completed", usage: {} } } },
  ];
}

async function startProxy(provider, registry) {
  const server = new Server({ provider, log: silentLog, usageTTL: 60, registry });
  return startHttpServer(server.handler());
}

function sseJSON(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const name = lines.find((part) => part.startsWith("event: "))?.slice("event: ".length);
    const payload = lines.find((part) => part.startsWith("data: "))?.slice("data: ".length);
    if (payload == null || payload === "[DONE]") continue;
    out.push({ type: name, data: JSON.parse(payload) });
  }
  return out;
}

test("chat completions renders a mermaid fence and notes the source in thinking", async () => {
  const provider = scriptedProvider(diagramEvents());
  const proxy = await startProxy(provider, new ToolRegistry().register(flowchart));
  try {
    const resp = await fetch(`${proxy.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        messages: [{ role: "user", content: "draw it" }],
      }),
    });
    const text = await resp.text();
    assert.match(text, /```svg/);
    assert.ok(!text.includes("[\\n  A[Start]"), "the raw fence must not reach the client as code");
    assert.ok(text.includes("plugin-fence"), "the source rides the thinking channel as a carried block");
    assert.ok(text.includes("flowchart TD"), "and it is the mermaid source, carried");
  } finally {
    await proxy.close();
  }
});

test("responses streams the rendered image in place of the fence", async () => {
  const provider = scriptedProvider(diagramEvents());
  const proxy = await startProxy(provider, new ToolRegistry().register(flowchart));
  try {
    const resp = await fetch(`${proxy.base}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "draw it" }),
    });
    const events = sseJSON(await resp.text());
    const deltas = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.data.delta).join("");
    assert.match(deltas, /```svg/);
    assert.ok(deltas.includes("Here is the flow:"));
    const item = events.find((e) => e.type === "response.output_item.done").data.item;
    assert.match(item.content[0].text, /```svg/);
  } finally {
    await proxy.close();
  }
});

test("a replayed chat diagram comes back as the model's own mermaid, never as svg", async () => {
  const sink = {};
  const provider = scriptedProvider(
    [
      { type: "response.output_text.delta", data: { delta: "ok" } },
      { type: "response.completed", data: { response: { id: "r", status: "completed", usage: {} } } },
    ],
    sink,
  );
  const proxy = await startProxy(provider, new ToolRegistry().register(flowchart));
  const rendered = flowchart.fences.mermaid(MERMAID);
  const carried = `<plugin-fence name="mermaid">\n${MERMAID}\n</plugin-fence>`;
  try {
    const resp = await fetch(`${proxy.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        messages: [
          { role: "user", content: "draw it" },
          { role: "assistant", content: `Here you go\n${rendered}`, reasoning_content: carried },
          { role: "user", content: "again" },
        ],
      }),
    });
    await resp.text();
    const assistant = sink.request.input.find((item) => item.role === "assistant");
    assert.ok(assistant, "the assistant turn is replayed");
    assert.match(assistant.content, /```mermaid/);
    assert.ok(assistant.content.includes("A[Start] --> B{Choice}"));
    assert.ok(!assistant.content.includes("<svg"), "the generated svg must not reach the model");
    assert.ok(!sink.request.input.some((item) => item.role === "developer"), "no tell that the answer was processed");
    assert.ok(!JSON.stringify(sink.request.input).includes("<svg"));
  } finally {
    await proxy.close();
  }
});

test("a replayed responses input restores the model's mermaid and strips the reasoning tell", async () => {
  const sink = {};
  const provider = scriptedProvider(
    [
      { type: "response.output_text.delta", data: { delta: "ok" } },
      { type: "response.completed", data: { response: { id: "r", status: "completed", usage: {} } } },
    ],
    sink,
  );
  const proxy = await startProxy(provider, new ToolRegistry().register(flowchart));
  const rendered = flowchart.fences.mermaid(MERMAID);
  const carried = `<plugin-fence name="mermaid">\n${MERMAID}\n</plugin-fence>`;
  try {
    const resp = await fetch(`${proxy.base}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "draw it" }] },
          { type: "reasoning", content: [{ type: "reasoning_text", text: `thinking${carried}` }] },
          { role: "assistant", content: [{ type: "output_text", text: rendered }] },
        ],
      }),
    });
    await resp.text();
    const assistant = sink.request.input.find((item) => item.role === "assistant");
    assert.match(assistant.content[0].text, /```mermaid/);
    assert.ok(assistant.content[0].text.includes("A[Start] --> B{Choice}"));
    assert.ok(!assistant.content[0].text.includes("<svg"), "the generated svg must not reach the model");
    const reasoning = sink.request.input.find((item) => item.type === "reasoning");
    assert.equal(reasoning.content[0].text, "thinking");
    assert.ok(!sink.request.input.some((item) => item.role === "developer"), "no tell that the answer was processed");
    assert.ok(!JSON.stringify(sink.request.input).includes("<svg"));
  } finally {
    await proxy.close();
  }
});
