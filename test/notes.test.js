import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResponsesRequestFromChat } from "../src/compat.js";
import { LEGACY_PREFIX, note, stripNotes } from "../src/notes.js";

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
    `${LEGACY_PREFIX} old format note\nkept line`,
  ];
  for (const input of cases) {
    const out = stripNotes(input);
    assert.ok(!/<ignore/i.test(out), `residue in ${JSON.stringify(out)} from ${JSON.stringify(input)}`);
    assert.ok(!/<\/ignore/i.test(out), `closer residue in ${JSON.stringify(out)}`);
    assert.ok(!out.includes(LEGACY_PREFIX), `legacy residue in ${JSON.stringify(out)}`);
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
  assert.ok(!payload.includes(LEGACY_PREFIX));
});
