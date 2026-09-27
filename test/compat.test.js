import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildResponsesRequestFromChat,
  normalizeResponsesRequest,
  resolveModel,
} from "../src/compat.js";

function userContent(req) {
  const input = req.input;
  assert.ok(Array.isArray(input) && input.length === 1, `expected one input item: ${JSON.stringify(input)}`);
  assert.equal(input[0].role, "user");
  return input[0].content;
}

function contentPart(content, index) {
  assert.ok(Array.isArray(content), `expected content parts: ${JSON.stringify(content)}`);
  assert.ok(content.length > index, `expected at least ${index + 1} parts: ${JSON.stringify(content)}`);
  return content[index];
}

test("normalizeResponsesRequest rewrites a web_search_preview tool", () => {
  const { request } = normalizeResponsesRequest({
    model: "gpt-5.5",
    input: "test input",
    tools: [{ type: "web_search_preview", search_context_size: "high" }],
    tool_choice: { type: "web_search_preview" },
  });

  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0].type, "web_search");
  assert.equal(request.tools[0].search_context_size, "high");
  assert.equal(request.tool_choice.type, "web_search");
});

test("normalizeResponsesRequest folds web_search_options into a tool", () => {
  const { request } = normalizeResponsesRequest({
    model: "gpt-5.5",
    input: "test input",
    web_search_options: {
      search_context_size: "medium",
      user_location: { country: "US" },
    },
  });

  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0].type, "web_search");
  assert.equal(request.tools[0].search_context_size, "medium");
  assert.deepEqual(request.tools[0].user_location, { country: "US", type: "approximate" });
});

test("normalizeResponsesRequest resolves a -search model without enabling search", () => {
  const { request } = normalizeResponsesRequest({ model: "gpt-5.5-search", input: "test input" });
  assert.equal(request.model, "gpt-5.5");
  assert.equal(request.tools, undefined);
});

test("resolveModel strips the aliases down to the same upstream model", () => {
  assert.equal(resolveModel("gpt-5.5-search"), "gpt-5.5");
  assert.equal(resolveModel("gpt-5.5-search-preview"), "gpt-5.5");
  assert.equal(resolveModel("gpt-4o-search-preview"), "gpt-5.5");
  assert.equal(resolveModel("gpt-5.5"), "gpt-5.5");
});

test("buildResponsesRequestFromChat folds web_search_options into a tool", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "What is the weather?" }],
    web_search_options: { search_context_size: "high" },
  });

  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0].type, "web_search");
  assert.equal(request.tools[0].search_context_size, "high");
});

test("buildResponsesRequestFromChat carries tools and tool_choice", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { type: "function", function: { name: "my_func" } },
      { type: "web_search_preview" },
    ],
    tool_choice: { type: "web_search_preview" },
  });

  assert.equal(request.tools.length, 2);
  assert.equal(request.tool_choice.type, "web_search");
});

test("buildResponsesRequestFromChat maps a -search model onto the base model", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-4o-search-preview",
    messages: [{ role: "user", content: "news" }],
  });

  assert.equal(request.model, "gpt-5.5");
  assert.equal(request.tools, undefined);
});

test("buildResponsesRequestFromChat still searches when the software toggle asks for it", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5-search",
    messages: [{ role: "user", content: "news" }],
    web_search_options: true,
  });

  assert.equal(request.tools.length, 1);
  assert.equal(request.tools[0].type, "web_search");
});

test("buildResponsesRequestFromChat honours the global search flag", () => {
  const base = {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "ping" }],
  };

  const enabled = buildResponsesRequestFromChat(base, { webSearch: true });
  assert.equal(enabled.request.tools.length, 1);
  assert.equal(enabled.request.tools[0].type, "web_search");

  const disabled = buildResponsesRequestFromChat(
    { ...base, web_search_options: false },
    { webSearch: true },
  );
  assert.equal(disabled.request.tools, undefined);
});

test("buildResponsesRequestFromChat forwards an image attachment", () => {
  const dataURL = "data:image/png;base64,iVBORw0KGgo=";
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image?" },
          { type: "image_url", image_url: { url: dataURL, detail: "high" } },
        ],
      },
    ],
  });

  const content = userContent(request);
  assert.deepEqual(contentPart(content, 0), { type: "input_text", text: "what is in this image?" });
  assert.deepEqual(contentPart(content, 1), { type: "input_image", image_url: dataURL, detail: "high" });
});

test("buildResponsesRequestFromChat accepts image_url as a plain string", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5",
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: "https://example.com/cat.png" }] },
    ],
  });

  assert.deepEqual(contentPart(userContent(request), 0), {
    type: "input_image",
    image_url: "https://example.com/cat.png",
  });
});

test("buildResponsesRequestFromChat forwards chat audio", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5",
    messages: [
      { role: "user", content: [{ type: "input_audio", input_audio: { data: "AQID", format: "mp3" } }] },
    ],
  });

  assert.deepEqual(contentPart(userContent(request), 0), {
    type: "input_audio",
    audio_url: "data:audio/mp3;base64,AQID",
  });
});

test("buildResponsesRequestFromChat rejects an attachment the backend cannot take", () => {
  assert.throws(
    () =>
      buildResponsesRequestFromChat({
        model: "gpt-5.5",
        messages: [
          { role: "user", content: [{ type: "file", file: { filename: "notes.pdf" } }] },
        ],
      }),
    /unsupported message content type "file"/,
  );
});

test("buildResponsesRequestFromChat leaves a plain string content alone", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(userContent(request), "hello");
});

function toolResult(request) {
  const item = request.input.find((entry) => entry.type === "function_call_output");
  assert.ok(item, `expected a function_call_output: ${JSON.stringify(request.input)}`);
  return item;
}

test("a text-only tool result stays a plain string", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5",
    messages: [
      { role: "user", content: "render it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "render", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "Rendered 12 slides." },
    ],
  });

  const result = toolResult(request);
  assert.equal(result.call_id, "call_1");
  assert.equal(result.output, "Rendered 12 slides.");
});

test("a tool result can hand an image back to the model", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5",
    messages: [
      { role: "user", content: "render it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "render", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "Rendered 1 slide." },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=", detail: "high" } },
        ],
      },
    ],
  });

  assert.deepEqual(toolResult(request).output, [
    { type: "input_text", text: "Rendered 1 slide." },
    { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=", detail: "high" },
  ]);
});

test("a tool result rejects content the backend cannot represent", () => {
  assert.throws(
    () =>
      buildResponsesRequestFromChat({
        model: "gpt-5.5",
        messages: [
          {
            role: "tool",
            tool_call_id: "call_1",
            content: [{ type: "file", file: { filename: "notes.pdf" } }],
          },
        ],
      }),
    /unsupported message content type "file"/,
  );
});
