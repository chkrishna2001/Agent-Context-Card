import assert from "node:assert/strict";
import test from "node:test";
import { increment } from "./counter.mjs";

test("increments values below the maximum", () => {
  assert.equal(increment(2, 5), 3);
});

test("does not increment a value already at the maximum", () => {
  assert.equal(increment(5, 5), 5);
});

test("does not cross the maximum", () => {
  assert.equal(increment(4.5, 5), 5);
});
