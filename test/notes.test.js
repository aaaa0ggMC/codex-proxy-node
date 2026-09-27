import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResponsesRequestFromChat } from "../src/compat.js";
import { note, stripNotes, stripWrapper } from "../src/notes.js";

test("stripWrapper leaves only the model's own thinking", () => {
  assert.equal(
    stripWrapper("<th><mth>real thinking</mth><ignore>docs__open …</ignore></th>"),
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
        reasoning_content: "<th><mth>weighing options</mth><ignore>docs__open …</ignore></th>",
      },
      { role: "user", content: "and page 2?" },
    ],
  });

  const item = request.input.find((entry) => entry.type === "reasoning");
  assert.deepEqual(item, { type: "reasoning", content: [{ type: "reasoning_text", text: "weighing options" }] });
});

test("stripNotes removes a note and leaves the surrounding answer alone", () => {
  assert.equal(stripNotes(`answer\n<th>${note("docs__read_page …")}</th>`), "answer");
  assert.equal(stripNotes("nothing to do"), "nothing to do");
  assert.equal(stripNotes(note("only a note")), "");
});

test("stripNotes keeps real model reasoning", () => {
  const history = `<th><mth>weighing options</mth>${note("docs__search …")}</th>`;
  assert.equal(stripNotes(history), "<th><mth>weighing options</mth></th>");
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
      { role: "assistant", content: `the answer\n<th>${note("docs__read_page …")}</th>` },
      { role: "user", content: "and page 2?" },
    ],
  });

  const assistant = request.input.find((item) => item.role === "assistant");
  assert.equal(assistant.content, "the answer");
  const payload = JSON.stringify(request);
  assert.ok(!payload.includes("<ignore"), "no marker may survive translation");
});

test("a disable_module switch is honoured once and never reaches the model", async () => {
  const { applyModuleSwitches } = await import("../src/modules.js");
  const messages = [
    { role: "system", content: "be terse" },
    { role: "user", content: [{ type: "text", text: "look at the deck\n<disable_module>docs</disable_module>" }] },
    { role: "assistant", content: "ok <disable_module name=\"other\" />" },
  ];

  const disabled = applyModuleSwitches(messages);
  assert.deepEqual([...disabled], ["docs"], "only the first user message carries the switch");
  assert.ok(!messages[1].content[0].text.includes("disable_module"), "the tag is removed");
  assert.equal(messages[1].content[0].text, "look at the deck");
});

test("both switch spellings are understood", async () => {
  const { extractModuleSwitches } = await import("../src/modules.js");
  assert.deepEqual(extractModuleSwitches(`<disable_module name="docs" />`).modules, ["docs"]);
  assert.deepEqual(extractModuleSwitches(`<disable_module>stepfun</disable_module>`).modules, ["stepfun"]);
  assert.deepEqual(extractModuleSwitches(`<disable_module docs />`).modules, ["docs"]);
  assert.equal(extractModuleSwitches("nothing here").text, "nothing here");
});
