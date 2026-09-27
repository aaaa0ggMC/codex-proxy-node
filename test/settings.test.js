import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_EDGE, imageMaxEdge, setImageMaxEdge } from "../src/docs/settings.js";

test("the image ceiling defaults to 1100 and is validated", () => {
  assert.equal(DEFAULT_MAX_EDGE, 1100);
  assert.equal(imageMaxEdge(), 1100);
  assert.equal(setImageMaxEdge(1600), 1600);
  assert.equal(imageMaxEdge(), 1600);
  assert.throws(() => setImageMaxEdge(100), /between 256 and 4096/);
  assert.throws(() => setImageMaxEdge("abc"), /between 256 and 4096/);
  assert.equal(setImageMaxEdge(1100), 1100, "reset for other tests");
});
