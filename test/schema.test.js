import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletionFromAggregate, openAIModelsResponse } from "../src/schema.js";

const models = [
  { slug: "gpt-5.5", supported_in_api: true, visibility: "list" },
  { slug: "gpt-6-astra", supported_in_api: true, visibility: "list" },
  { slug: "hidden", supported_in_api: true, visibility: "hidden" },
  { slug: "no-api", supported_in_api: false, visibility: "list" },
];

test("openAIModelsResponse keeps the -search aliases listed for saved histories", () => {
  const ids = openAIModelsResponse(models).data.map((m) => m.id);
  for (const id of [
    "gpt-5.5",
    "gpt-5.5-search",
    "gpt-5.5-search-preview",
    "gpt-6-astra",
    "gpt-6-astra-search",
    "gpt-6-astra-search-preview",
    "gpt-4o-search-preview",
  ]) {
    assert.ok(ids.includes(id), `expected ${id} in ${ids.join(", ")}`);
  }
  assert.ok(!ids.includes("hidden"));
  assert.ok(!ids.includes("no-api"));
});

test("chatCompletionFromAggregate carries annotations through", () => {
  const agg = {
    id: "resp_123456",
    created_at: 1000,
    outputText: "test answer",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "test answer",
            annotations: [{ type: "url_citation", url: "https://example.com", title: "Example" }],
          },
        ],
      },
    ],
  };

  const chat = chatCompletionFromAggregate(agg, "gpt-5.5");
  assert.equal(chat.choices.length, 1);
  assert.equal(chat.id, "chatcmpl-123456");
  const annotations = chat.choices[0].message.annotations;
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].url, "https://example.com");
});
