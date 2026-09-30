import { test } from "node:test";
import assert from "node:assert/strict";
import { attachOnce, carriedBlock, contextText, hasCarried, parseCarried, userText } from "../src/sdk.js";

test("carriedBlock writes a named block and a bare one", () => {
  assert.equal(carriedBlock("checkpoint", { body: "state" }), "<checkpoint>\nstate\n</checkpoint>");
  assert.equal(carriedBlock("plugin-inject", { name: "flowchart", body: "lore" }), '<plugin-inject name="flowchart">\nlore\n</plugin-inject>');
});

test("parseCarried lifts every carried tag and leaves the rest", () => {
  const text = "before <plugin-inject name=\"a\">\nA\n</plugin-inject> middle <checkpoint>B</checkpoint> after";
  const { cleaned, blocks } = parseCarried(text);
  assert.deepEqual(blocks, [
    { tag: "plugin-inject", name: "a", body: "A" },
    { tag: "checkpoint", name: "", body: "B" },
  ]);
  assert.match(cleaned, /before\s+middle\s+after/);
});

test("parseCarried ignores text that only looks like a tag", () => {
  const text = "a <plugin-inject-other> block";
  assert.deepEqual(parseCarried(text), { cleaned: text, blocks: [] });
  assert.deepEqual(parseCarried("plain"), { cleaned: "plain", blocks: [] });
});

test("hasCarried can match by tag and by name", () => {
  const text = '<plugin-inject name="flowchart">\nL\n</plugin-inject>';
  assert.equal(hasCarried(text), true);
  assert.equal(hasCarried(text, { tag: "plugin-inject", name: "flowchart" }), true);
  assert.equal(hasCarried(text, { name: "docs" }), false);
});

test("attachOnce adds what is missing and skips what the client already holds", () => {
  const fresh = attachOnce([{ role: "user", content: "hi" }], [{ tag: "plugin-inject", name: "a", body: "A" }]);
  assert.equal(fresh.append.length, 1);
  assert.equal(fresh.append[0].role, "developer");
  assert.deepEqual(fresh.carried, [fresh.append[0].content]);

  const held = attachOnce(
    [{ role: "user", content: "hi" }, { role: "developer", content: "Context carried over from earlier turns:\nA" }],
    [{ tag: "plugin-inject", name: "a", body: "A" }],
  );
  assert.equal(held, null);
});

test("attachOnce skips empty bodies and returns null when nothing is added", () => {
  assert.equal(attachOnce([], [{ tag: "plugin-inject", name: "a", body: "" }]), null);
  assert.equal(attachOnce([], []), null);
});

test("userText reads only user messages; contextText reads everything replayed", () => {
  const input = [
    { role: "user", content: "from the user" },
    { role: "assistant", content: [{ type: "output_text", text: "from the model" }] },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }] },
    { type: "function_call_output", output: [{ type: "input_text", text: "tool said" }] },
  ];
  assert.equal(userText(input), "from the user");
  for (const text of ["from the user", "from the model", "thinking", "tool said"]) {
    assert.ok(contextText(input).includes(text), `missing ${text}`);
  }
});
