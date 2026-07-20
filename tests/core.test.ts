import { describe, expect, test } from "bun:test";
import { taskBoundaryForInput } from "../src/core/anchor";
import { buildExecutionJournal } from "../src/core/execution";
import { formatContextCard } from "../src/core/format";
import { projectContext } from "../src/core/projection";
import type { ContextMessage, ToolCall } from "../src/core/types";

const user = (raw: string): ContextMessage<string> => ({
  raw,
  role: "user",
  text: raw,
  toolCalls: [],
});
const assistant = (raw: string, call?: ToolCall): ContextMessage<string> => ({
  raw,
  toolOnlyRaw: call ? `${raw}:tools-only` : undefined,
  role: "assistant",
  text: raw,
  toolCalls: call ? [call] : [],
});
const result = (
  raw: string,
  call: ToolCall,
  isError = false,
): ContextMessage<string> => ({
  raw,
  role: "toolResult",
  text: raw,
  toolCalls: [],
  toolResult: { callId: call.id, toolName: call.name, isError },
});
const call = (
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): ToolCall => ({ id, name, arguments: arguments_ });

describe("context projection", () => {
  test("retires duplicate rounds and keeps the newest result", () => {
    const first = call("1", "shell_command", { command: "bun test" });
    const second = call("2", "shell_command", { command: "bun test" });
    const projected = projectContext([
      user("test it"),
      assistant("first", first),
      result("old", first),
      assistant("second", second),
      result("new", second),
    ]);
    expect(projected.messages).toEqual(["test it", "second:tools-only", "new"]);
    expect(projected.retired.duplicate).toBe(1);
  });

  test("retires discovery once a discovered file is read", () => {
    const listing = call("1", "shell_command", {
      command: "Get-ChildItem src",
    });
    const read = call("2", "read", { path: "src/index.ts" });
    const projected = projectContext([
      user("inspect"),
      assistant("listing", listing),
      result("src/index.ts", listing),
      assistant("reading", read),
      result("contents", read),
    ]);
    expect(projected.messages).toEqual([
      "inspect",
      "reading:tools-only",
      "contents",
    ]);
    expect(projected.retired.discovery).toBe(1);
    expect(projected.hotEvidence[0]).toMatchObject({
      path: "src/index.ts",
      state: "active",
    });
  });

  test("keeps a read through its mutation grace boundary, then retires it", () => {
    const read = call("1", "read", { path: "src/index.ts" });
    const edit = call("2", "edit", { path: "src/index.ts" });
    const validation = call("3", "shell_command", { command: "bun test" });
    const beforeGrace = projectContext([
      user("change it"),
      assistant("read", read),
      result("contents", read),
      assistant("edit", edit),
      result("done", edit),
    ]);
    expect(beforeGrace.messages).toContain("read:tools-only");

    const afterGrace = projectContext([
      user("change it"),
      assistant("read", read),
      result("contents", read),
      assistant("edit", edit),
      result("done", edit),
      assistant("validate", validation),
      result("pass", validation),
    ]);
    expect(afterGrace.messages).not.toContain("read:tools-only");
    expect(afterGrace.retired.staleRead).toBe(1);
  });

  test("retains only the configured recent task turns", () => {
    const projected = projectContext(
      [
        user("one"),
        assistant("answer one"),
        user("two"),
        assistant("answer two"),
        user("three"),
        assistant("answer three"),
      ],
      2,
    );
    expect(projected.messages).toEqual([
      "two",
      "answer two",
      "three",
      "answer three",
    ]);
    expect(projected.retiredTurns).toBe(1);
  });
});

describe("card extraction", () => {
  test("a later success resolves the same failure", () => {
    const first = call("1", "shell_command", { command: "bun test" });
    const second = call("2", "shell_command", { command: "bun test" });
    const journal = buildExecutionJournal([
      user("test"),
      assistant("run", first),
      result("failed", first, true),
      assistant("retry", second),
      result("passed", second),
    ]);
    expect(journal.failures).toEqual([]);
    expect(journal.changes[0]).toMatchObject({
      kind: "validation",
      status: "success",
      count: 2,
    });
  });

  test("does not truncate a complex task into a fixed card budget", () => {
    const goal = "x".repeat(20_000);
    const card = formatContextCard({
      goal,
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
    });
    expect(card).toContain(goal);
  });
});

test("task boundaries favor continuation while work is unsettled", () => {
  expect(
    taskBoundaryForInput("document it too", {
      goal: "fix export",
      settled: false,
    }),
  ).toBe("continue");
  expect(
    taskBoundaryForInput("new unrelated task: add auth", {
      goal: "fix export",
      settled: false,
    }),
  ).toBe("new");
});
