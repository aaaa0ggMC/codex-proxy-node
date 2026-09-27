import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResponsesRequestFromChat } from "../src/compat.js";
import { NOTE_PREFIX, note, stripNotes } from "../src/notes.js";

test("stripNotes removes tagged lines and keeps the rest", () => {
  const text = ["first line", note("docs__read_page …"), "last line"].join("\n");
  assert.equal(stripNotes(text), "first line\nlast line");
  assert.equal(stripNotes("nothing to do"), "nothing to do");
  assert.equal(stripNotes(`${NOTE_PREFIX} only a note`), "");
});

test("a replayed note never reaches the model", () => {
  const { request } = buildResponsesRequestFromChat({
    model: "gpt-5.5",
    messages: [
      { role: "user", content: "read the deck" },
      { role: "assistant", content: `the answer\n${note("docs__read_page …")}` },
      { role: "user", content: "and page 2?" },
    ],
  });

  const assistant = request.input.find((item) => item.role === "assistant");
  assert.equal(assistant.content, "the answer");
  assert.ok(!JSON.stringify(request).includes(NOTE_PREFIX), "no marker may survive translation");
});
