import assert from "node:assert/strict";
import test from "node:test";
import { decrement } from "./counter.mjs";

test("decrements values above the minimum", () => {
  assert.equal(decrement(3, 0), 2);
});

test("does not decrement a value already at the minimum", () => {
  assert.equal(decrement(0, 0), 0);
});

test("does not cross the minimum", () => {
  assert.equal(decrement(0.5, 0), 0);
});
