import { describe, expect, test } from "bun:test";
import { buildExecutionJournal } from "../src/core/execution";
import {
  formatContextCard,
  planPhaseFramingState,
  planProjectionState,
} from "../src/core/format";
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

  test("does not grow monotonically across ten completed turns", () => {
    const messages = Array.from({ length: 10 }, (_, index) => [
      user(`request ${index + 1}`),
      assistant(`answer ${index + 1}`),
    ]).flat();
    const projected = projectContext(messages, 2);
    expect(projected.messages).toEqual([
      "request 9",
      "answer 9",
      "request 10",
      "answer 10",
    ]);
    expect(projected.retiredTurns).toBe(8);
    expect(projected.messages).toHaveLength(4);
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

  test("shows taskId in the rendered card when available", () => {
    const card = formatContextCard({
      goal: "Implement JIRA-123",
      taskId: "JIRA-123",
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
    });
    expect(card).toContain("TASK ID: JIRA-123");
  });

  test("phase-aware projection retires a completed plan body only outside execution phases", () => {
    const runtimeCard = {
      goal: "Plan JIRA-124",
      latestRequest:
        "Document JIRA-124 in README.md without changing production code",
      capabilities: { documentation: ["README.md"], validation: ["bun test"] },
      execution: { changes: [], failures: [] },
      plan: {
        content: "PLAN-MARKER-JIRA-124\n1. Inspect\n2. Implement",
        revision: 1,
        sourceTurn: 0,
        capturedAt: "2026-07-23T00:00:00.000Z",
      },
      resumed: {
        repositoryChanged: false,
        execution: {
          changes: [
            {
              action: "edit source.ts",
              kind: "change" as const,
              status: "success" as const,
              count: 1,
            },
            {
              action: "shell_command bun test",
              kind: "validation" as const,
              status: "success" as const,
              count: 1,
            },
          ],
          failures: [],
        },
      },
    };
    const full = formatContextCard(runtimeCard);
    const phaseAware = formatContextCard(runtimeCard, {
      planProjectionMode: "phase-aware",
    });
    expect(full).toContain("PLAN-MARKER-JIRA-124");
    expect(phaseAware).toContain("PLAN STATE (revision 1)");
    expect(phaseAware).not.toContain("PLAN-MARKER-JIRA-124");
    expect(
      planProjectionState(runtimeCard, {
        planProjectionMode: "phase-aware",
      }),
    ).toBe("retired");

    const validation = formatContextCard(
      { ...runtimeCard, latestRequest: "Validate JIRA-124 with bun test" },
      { planProjectionMode: "phase-aware" },
    );
    expect(validation).toContain("PLAN-MARKER-JIRA-124");
    expect(
      planProjectionState(
        { ...runtimeCard, latestRequest: "Validate JIRA-124 with bun test" },
        { planProjectionMode: "phase-aware" },
      ),
    ).toBe("full");
  });

  test("preserves a pinned plan verbatim while expiring planning-only constraints", () => {
    const plan =
      "PLAN-MARKER-JIRA-125\nDo not modify files.\n1. Implement the fix.";
    const card = formatContextCard(
      {
        goal: "Plan JIRA-125",
        latestRequest: "Implement JIRA-125 now",
        capabilities: { documentation: [], validation: [] },
        execution: { changes: [], failures: [] },
        plan: {
          content: plan,
          revision: 1,
          sourceTurn: 0,
          capturedAt: "2026-07-23T00:00:00.000Z",
        },
      },
      { planPhaseFramingMode: "scope-note" },
    );
    expect(card).toContain("The current request is post-planning");
    expect(card.replace(/^  /gm, "")).toContain(plan);
    expect(
      planPhaseFramingState({
        goal: "Plan JIRA-125",
        latestRequest: "Implement JIRA-125 now",
        capabilities: { documentation: [], validation: [] },
        execution: { changes: [], failures: [] },
        plan: {
          content: plan,
          revision: 1,
          sourceTurn: 0,
          capturedAt: "2026-07-23T00:00:00.000Z",
        },
      }),
    ).toBe("disabled");
    expect(
      planPhaseFramingState(
        {
          goal: "Plan JIRA-125",
          latestRequest: "Revise the plan for JIRA-125",
          capabilities: { documentation: [], validation: [] },
          execution: { changes: [], failures: [] },
          plan: {
            content: plan,
            revision: 1,
            sourceTurn: 0,
            capturedAt: "2026-07-23T00:00:00.000Z",
          },
        },
        { planPhaseFramingMode: "scope-note" },
      ),
    ).toBe("planning");
  });
  test("keeps the exact pinned plan and labels resumed facts as historical", () => {
    const card = formatContextCard({
      goal: "Implement JIRA-123",
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
      plan: {
        content: "1. Inspect\n2. Implement",
        revision: 2,
        sourceTurn: 1,
        capturedAt: "2026-07-21T00:00:00.000Z",
      },
      resumed: {
        repositoryChanged: true,
        execution: {
          changes: [
            {
              action: "shell_command bun test",
              kind: "validation",
              status: "success",
              count: 1,
            },
          ],
          failures: [],
        },
      },
    });
    expect(card).toContain("PINNED PLAN (revision 2)");
    expect(card).toContain("1. Inspect\n  2. Implement");
    expect(card).toContain("PRIOR SESSION VERIFIED FACTS");
    expect(card).toContain("REPOSITORY STATE CHANGED");
  });
});
