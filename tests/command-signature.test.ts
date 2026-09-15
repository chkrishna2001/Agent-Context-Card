import { describe, expect, test } from "bun:test";
import { commandSignature } from "../src/core/command-signature";

describe("commandSignature", () => {
  test("extracts verb and pattern from a basic grep call", () => {
    expect(
      commandSignature('grep "def as_set" sympy/core/relational.py'),
    ).toEqual({ verb: "grep", pattern: "def as_set" });
  });

  test("ignores flags before the pattern", () => {
    expect(commandSignature('grep -r "def as_set" sympy/core')).toEqual({
      verb: "grep",
      pattern: "def as_set",
    });
  });

  test("normalizes to the same key regardless of trailing file list", () => {
    const first = commandSignature(
      'grep -r "def as_set" sympy/core/relational.py sympy/core/expr.py',
    );
    const second = commandSignature(
      'grep -r "def as_set" sympy/core/relational.py sympy/core/expr.py sympy/sets/sets.py',
    );
    expect(first).toEqual(second);
  });

  test("different search patterns sharing a verb produce different keys", () => {
    const first = commandSignature('grep "def as_set" sympy/core');
    const second = commandSignature('grep "def solve" sympy/core');
    expect(first).not.toEqual(second);
  });

  test("handles rg and ag the same way as grep", () => {
    expect(commandSignature('rg "TODO" src/')).toEqual({
      verb: "rg",
      pattern: "TODO",
    });
    expect(commandSignature('ag "TODO" src/')).toEqual({
      verb: "ag",
      pattern: "TODO",
    });
  });

  test("extracts the -name/-iname value from find, ignoring the leading path", () => {
    expect(commandSignature('find sympy/core -name "*.py"')).toEqual({
      verb: "find",
      pattern: "*.py",
    });
    expect(commandSignature('find . -iname "*.PY"')).toEqual({
      verb: "find",
      pattern: "*.PY",
    });
  });

  test("returns undefined for commands outside the allow-list", () => {
    expect(commandSignature("python reproduce_issue.py")).toBeUndefined();
    expect(commandSignature("ls -la")).toBeUndefined();
    expect(commandSignature("cat sympy/core/relational.py")).toBeUndefined();
  });

  test("returns undefined when no pattern argument is present", () => {
    expect(commandSignature("grep")).toBeUndefined();
    expect(commandSignature("find . -type f")).toBeUndefined();
  });

  test("returns undefined for an empty command", () => {
    expect(commandSignature("")).toBeUndefined();
    expect(commandSignature("   ")).toBeUndefined();
  });
});
