import { describe, expect, test } from "bun:test";
import { buildExecutionJournal } from "../src/core/execution";
import {
  formatCardStatus,
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

  test("renders flat top-level fields in the documented order", () => {
    const runtimeCard = {
      goal: "Implement JIRA-123",
      taskId: "JIRA-123",
      capabilities: {
        description: "Deterministic context projection",
        packageName: "agent-context-card",
        packageManager: "bun",
        documentation: ["README.md"],
        validation: ["bun test"],
      },
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
            count: 2,
          },
        ],
        failures: [
          {
            action: "edit missing.ts",
            kind: "change" as const,
            status: "failed" as const,
            count: 1,
            detail: "ENOENT",
          },
        ],
      },
      pending: ["verify rebuild"],
      findings: [{ topic: "schema", detail: "no caps allowed" }],
      repo: {
        root: "C:/Users/chkri/source/repos/agent-context-card",
        head: "abcdef0123456789abcdef0123456789abcdef01",
      },
    };
    const card = formatContextCard(runtimeCard);
    expect(card).toContain("goal: Implement JIRA-123");
    expect(card).toContain("TASK ID: JIRA-123");
    expect(card).toContain("project: Deterministic context projection");
    expect(card).toContain(
      "repo: C:/Users/chkri/source/repos/agent-context-card @ abcdef01",
    );
    const goalIdx = card.indexOf("goal:");
    const taskIdIdx = card.indexOf("TASK ID:");
    const projectIdx = card.indexOf("project:");
    const repoIdx = card.indexOf("repo:");
    expect(goalIdx).toBeLessThan(taskIdIdx);
    expect(taskIdIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(repoIdx);

    // The volatile fields (execution, pending, findings, failures) render
    // separately so their churn doesn't invalidate a provider's prefix
    // cache for the stable card above.
    const status = formatCardStatus(runtimeCard);
    expect(status).toContain(
      "what happened: edit source.ts; shell_command bun test ×2",
    );
    expect(status).toContain("what's pending: verify rebuild");
    expect(status).toContain("findings: schema: no caps allowed");
    expect(status).toContain("failures: edit missing.ts — ENOENT");
    const whatIdx = status.indexOf("what happened:");
    const pendingIdx = status.indexOf("what's pending:");
    const findingsIdx = status.indexOf("findings:");
    const failuresIdx = status.indexOf("failures:");
    expect(whatIdx).toBeLessThan(pendingIdx);
    expect(pendingIdx).toBeLessThan(findingsIdx);
    expect(findingsIdx).toBeLessThan(failuresIdx);
  });

  test("omits empty fields entirely rather than rendering blanks", () => {
    const card = formatContextCard({
      goal: "Inspect the project",
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
    });
    expect(card).not.toContain("project:");
    expect(card).not.toContain("repo:");

    const status = formatCardStatus({
      goal: "Inspect the project",
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
    });
    expect(status).toBe("");
  });

  test("renders repo from a headless provenance as just the root path", () => {
    const card = formatContextCard({
      goal: "Inspect",
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
      repo: {
        root: "C:/work/no-git",
      },
    });
    expect(card).toContain("repo: C:/work/no-git");
    expect(card).not.toContain("@");
  });

  test("renders only non-active files read between findings and failures when present", () => {
    const status = formatCardStatus({
      goal: "Inspect",
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
      findings: [{ topic: "todo", detail: "see helper" }],
      filesRead: [
        {
          path: "src/a.ts",
          version: "1",
          toolCallId: "a",
          state: "active",
        },
        {
          path: "src/b.ts",
          version: "2",
          toolCallId: "b",
          state: "consumed",
        },
      ],
    });
    // src/a.ts is "active": its full content is still visible in the
    // projected transcript, so repeating its path here is pure redundant
    // token cost. Only src/b.ts ("consumed") is worth telling the model
    // about, since that content is no longer directly visible.
    expect(status).toContain("files read: src/b.ts (consumed)");
    expect(status).not.toContain("src/a.ts");
    const findingsIdx = status.indexOf("findings:");
    const filesIdx = status.indexOf("files read:");
    expect(findingsIdx).toBeGreaterThan(-1);
    expect(filesIdx).toBeGreaterThan(findingsIdx);
    expect(status).not.toContain("failures:");
  });

  test("omits files read line entirely when filesRead is empty, absent, or all-active", () => {
    const empty = formatCardStatus({
      goal: "Inspect",
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
      filesRead: [],
    });
    expect(empty).not.toContain("files read:");

    const missing = formatCardStatus({
      goal: "Inspect",
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
    });
    expect(missing).not.toContain("files read:");

    const allActive = formatCardStatus({
      goal: "Inspect",
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
      filesRead: [
        { path: "src/a.ts", version: "1", toolCallId: "a", state: "active" },
        { path: "src/c.ts", version: "3", toolCallId: "c", state: "active" },
      ],
    });
    expect(allActive).not.toContain("files read:");
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
    const runtimeCard = {
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
              kind: "validation" as const,
              status: "success" as const,
              count: 1,
            },
          ],
          failures: [],
        },
      },
    };
    const card = formatContextCard(runtimeCard);
    expect(card).toContain("PINNED PLAN (revision 2)");
    expect(card).toContain("1. Inspect\n  2. Implement");

    // Resumed facts are volatile (they fold into "what happened" as the
    // session progresses), so they render in formatCardStatus, not the
    // stable card.
    const status = formatCardStatus(runtimeCard);
    expect(status).toContain("PRIOR SESSION VERIFIED FACTS");
    expect(status).toContain("REPOSITORY STATE CHANGED");
  });
});
