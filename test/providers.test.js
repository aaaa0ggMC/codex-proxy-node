import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatProvider } from "../src/providers/openai.js";
import { toChatRequest } from "../src/providers/chat-bridge.js";
import { startHttpServer } from "../test-support/helpers.js";

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function chatSSE(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function fakeOpenAI({ chunks }) {
  const state = { body: null, headers: null, path: null };
  const upstream = await startHttpServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    state.path = url.pathname;
    state.headers = req.headers;
    if (url.pathname === "/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "step-3" }, { id: "step-3-mini" }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.body = JSON.parse(body);
      if (state.fail) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad model" } }));
        return;
      }
      chatSSE(res, chunks);
    });
  });
  return { ...upstream, state };
}

test("toChatRequest flattens canonical input into chat messages", () => {
  const body = toChatRequest(
    {
      model: "m",
      instructions: "be terse",
      input: [
        { role: "user", content: "look at this" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "docs_read_page",
          arguments: '{"page":2}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "page two" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
          ],
        },
      ],
      tools: [{ type: "function", name: "docs_read_page", description: "d", parameters: { type: "object" } }],
      tool_choice: "auto",
      reasoning: { effort: "low" },
    },
    { model: "m" },
  );

  assert.equal(body.messages[0].role, "system");
  assert.deepEqual(body.messages[1], { role: "user", content: "look at this" });
  assert.deepEqual(body.messages[2], {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name: "docs_read_page", arguments: '{"page":2}' } }],
  });
  assert.deepEqual(body.messages[3], {
    role: "tool",
    tool_call_id: "call_1",
    content: [
      { type: "text", text: "page two" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
    ],
  });
  assert.deepEqual(body.tools, [
    { type: "function", function: { name: "docs_read_page", description: "d", parameters: { type: "object" } } },
  ]);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.reasoning_effort, "low");
});

test("toChatRequest keeps a text-only message a plain string", () => {
  const body = toChatRequest({ input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] }, { model: "m" });
  assert.equal(body.messages[0].content, "hi");
});

test("the openai provider translates a chat stream into Responses events", async () => {
  const upstream = await fakeOpenAI({
    chunks: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "he" } }] },
      { choices: [{ index: 0, delta: { content: "llo" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ],
  });
  try {
    const provider = new OpenAICompatProvider({ baseURL: upstream.base, apiKey: "sk-test", reasoningEffort: "low" });
    const events = await collect(
      provider.events({ model: "step-3", input: [{ role: "user", content: "hi" }] }),
    );

    assert.deepEqual(events.map((e) => e.type), [
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    assert.equal(events[0].data.delta, "he");
    assert.equal(events[2].data.item.content[0].text, "hello");
    assert.equal(events[3].data.response.usage.total_tokens, 5);

    assert.equal(upstream.state.body.model, "step-3");
    assert.equal(upstream.state.body.reasoning_effort, "low");
    assert.equal(upstream.state.body.stream, true);
    assert.equal(upstream.state.headers.authorization, "Bearer sk-test");
  } finally {
    await upstream.close();
  }
});

test("the openai provider surfaces an upstream tool call as a function_call item", async () => {
  const upstream = await fakeOpenAI({
    chunks: [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "docs_search", arguments: '{"q"' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ],
  });
  try {
    const provider = new OpenAICompatProvider({ baseURL: upstream.base });
    const events = await collect(provider.events({ model: "m", input: [{ role: "user", content: "find" }] }));
    const call = events.find((e) => e.data?.item?.type === "function_call");
    assert.ok(call, `expected a function_call in ${JSON.stringify(events.map((e) => e.type))}`);
    assert.equal(call.data.item.name, "docs_search");
    assert.equal(call.data.item.arguments, '{"q":"x"}');
  } finally {
    await upstream.close();
  }
});

test("the openai provider maps /models and reports upstream errors with a status", async () => {
  const upstream = await fakeOpenAI({ chunks: [] });
  try {
    const provider = new OpenAICompatProvider({ baseURL: upstream.base });
    const models = await provider.models();
    assert.deepEqual(models.map((m) => m.slug), ["step-3", "step-3-mini"]);
    assert.equal(models[0].supported_in_api, true);

    upstream.state.fail = true;
    await assert.rejects(
      collect(provider.events({ model: "m", input: [{ role: "user", content: "hi" }] })),
      (err) => err.status === 400 && /bad model/.test(err.message),
    );

    assert.equal(await provider.usage(), null);
  } finally {
    await upstream.close();
  }
});

test("the bridge carries thinking under either field name", async () => {
  const upstream = await fakeOpenAI({
    chunks: [
      { choices: [{ index: 0, delta: { reasoning: "stepfun spells it reasoning. " } }] },
      { choices: [{ index: 0, delta: { reasoning_content: "deepseek spells it reasoning_content. " } }] },
      { choices: [{ index: 0, delta: { content: "answer" } }] },
    ],
  });
  try {
    const provider = new OpenAICompatProvider({ baseURL: upstream.base });
    const events = await collect(provider.events({ model: "m", input: [{ role: "user", content: "hi" }] }));
    const thinking = events
      .filter((event) => event.type === "response.reasoning_summary_text.delta")
      .map((event) => event.data.delta)
      .join("");
    assert.equal(thinking, "stepfun spells it reasoning. deepseek spells it reasoning_content. ");
  } finally {
    await upstream.close();
  }
});
