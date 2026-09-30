import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResponsesRequestFromChat } from "../src/compat.js";
import { note, stripNotes, stripWrapper } from "../src/notes.js";

test("stripWrapper leaves only the model's own thinking", () => {
  assert.equal(
    stripWrapper("<th><mth>real thinking</mth><ignore>proxy_docs_open …</ignore></th>"),
    "real thinking",
  );
});

test("replayed thinking goes back as a reasoning item", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "deepseek-flash",
    messages: [
      { role: "user", content: "look at the deck" },
      {
        role: "assistant",
        content: "here is the answer",
        reasoning_content: "<th><mth>weighing options</mth><ignore>proxy_docs_open …</ignore></th>",
      },
      { role: "user", content: "and page 2?" },
    ],
  });

  const item = request.input.find((entry) => entry.type === "reasoning");
  assert.deepEqual(item, { type: "reasoning", content: [{ type: "reasoning_text", text: "weighing options" }] });
});

test("stripNotes removes a note and leaves the surrounding answer alone", () => {
  assert.equal(stripNotes(`answer\n<th>${note("proxy_docs_read_page …")}</th>`), "answer");
  assert.equal(stripNotes("nothing to do"), "nothing to do");
  assert.equal(stripNotes(note("only a note")), "");
});

test("stripNotes keeps real model reasoning", () => {
  const history = `<th><mth>weighing options</mth>${note("proxy_docs_search …")}</th>`;
  const out = stripNotes(history);
  assert.match(out, /weighing options/, "the model reasoning survives");
  assert.ok(!out.includes("<ignore"), "the note is gone");
});

test("stripNotes leaves nothing behind for awkward shapes", () => {
  const cases = [
    `<ignore>unterminated`,
    note(`<ignore>nested</ignore>outer`),
    `before<ignore>a</ignore>middle<ignore>b</ignore>after`,
    `broken</ignore>closer`,
    `<th>${note("<ignore>x</ignore>y")}</th>`,
  ];
  for (const input of cases) {
    const out = stripNotes(input);
    assert.ok(!/<ignore/i.test(out), `residue in ${JSON.stringify(out)} from ${JSON.stringify(input)}`);
    assert.ok(!/<\/ignore/i.test(out), `closer residue in ${JSON.stringify(out)}`);
  }
});

test("a replayed thinking block never reaches the model", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5",
    messages: [
      { role: "user", content: "read the deck" },
      { role: "assistant", content: `the answer\n<th>${note("proxy_docs_read_page …")}</th>` },
      { role: "user", content: "and page 2?" },
    ],
  });

  const assistant = request.input.find((item) => item.role === "assistant");
  assert.equal(assistant.content, "the answer");
  const payload = JSON.stringify(request);
  assert.ok(!payload.includes("<ignore"), "no marker may survive translation");
});

test("module switches are read from every user message and never reach the model", async () => {
  const { applyModuleSwitches } = await import("../src/modules.js");
  const messages = [
    { role: "system", content: "be terse" },
    { role: "user", content: [{ type: "text", text: "look at the deck\n<disable_module>docs</disable_module>" }] },
    { role: "assistant", content: 'ok <disable_module name="other" />' },
    { role: "user", content: "and <disable_module>other</disable_module> too" },
  ];

  const { disabled, switches } = applyModuleSwitches(messages, ["docs", "other"]);
  assert.deepEqual([...disabled].sort(), ["docs", "other"], "a later user message switches too");
  assert.equal(switches.length, 2);
  assert.equal(messages[1].content[0].text, "look at the deck");
  assert.ok(!messages[2].content.includes("disable_module"), "a tag is stripped wherever it appears");
  assert.equal(messages[3].content, "and  too");
});

test("the spellings and the all/except form are understood", async () => {
  const { extractModuleSwitches, applyModuleSwitches } = await import("../src/modules.js");

  assert.deepEqual(extractModuleSwitches('<disable_module name="docs" />').switches, [{ verb: "disable", name: "docs" }]);
  assert.deepEqual(extractModuleSwitches("<disable_module>stepfun</disable_module>").switches, [
    { verb: "disable", name: "stepfun" },
  ]);
  assert.deepEqual(extractModuleSwitches("<disable_module docs />").switches, [{ verb: "disable", name: "docs" }]);
  assert.equal(extractModuleSwitches("nothing here").text, "nothing here");

  const messages = [
    {
      role: "user",
      content:
        "<disable_modules>all</disable_modules><enable_modules>docs</enable_modules> please read it",
    },
  ];
  const { disabled } = applyModuleSwitches(messages, ["docs", "other", "stepfun"]);
  assert.deepEqual([...disabled].sort(), ["other", "stepfun"], "all, except docs");
  assert.equal(messages[0].content, "please read it");
});

test("the switch works on the responses input shape too", async () => {
  const { applyInputSwitches } = await import("../src/modules.js");
  const input = [
    {
      role: "user",
      content: '<disable_modules>all</disable_modules><enable_module name="docs" />please read the deck',
    },
    { role: "user", content: [{ type: "input_text", text: "and page 2?" }] },
  ];
  const { disabled, switches } = applyInputSwitches(input, ["docs", "other"]);
  assert.deepEqual([...disabled], ["other"], "a plain-string content switches too");
  assert.deepEqual(switches, [{ verb: "disable", name: "all" }, { verb: "enable", name: "docs" }]);
  assert.equal(input[0].content, "please read the deck");
});

test("a checkpoint from the replayed history comes back as context", async () => {
  const { checkpoint } = await import("../src/checkpoints.js");
  const messages = [
    { role: "user", content: "read the deck" },
    {
      role: "assistant",
      content: "done",
      reasoning_content: `<th><mth>opened it</mth>${checkpoint("doc_abc = deck.pptx (10 slides)")}</th>`,
    },
    { role: "user", content: "and page 2?" },
  ];

  const { request } = buildResponsesRequestFromChat({ model: "gpt-5.5", messages });
  const carried = request.input[request.input.length - 1];
  assert.equal(carried.role, "developer");
  assert.match(carried.content, /doc_abc = deck\.pptx \(10 slides\)/);
  assert.ok(!JSON.stringify(request).includes("<checkpoint>"), "the tag must not reach the provider");

  // The same history must produce the same bytes, or the prompt cache would be lost every turn.
  const again = buildResponsesRequestFromChat({ model: "gpt-5.5", messages });
  assert.deepEqual(again.request.input, request.input);
});
