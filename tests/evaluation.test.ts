import { describe, expect, test } from "bun:test";
import {
  aggregateTurns,
  analyzeSession,
  analyzeTrace,
  parseJsonLines,
  percentChange,
  summarizeAudits,
} from "../scripts/evaluation/metrics.mjs";
import {
  sanitizePatch,
  summarizeOfficialReport,
} from "../scripts/evaluation/swebench.mjs";

const lines = (values: unknown[]) =>
  values.map((value) => JSON.stringify(value)).join("\n");

describe("evaluation metrics", () => {
  test("collects provider, cache, cost, tool, retry, and compaction metrics", () => {
    const trace = analyzeTrace(
      lines([
        { type: "session", id: "session-1" },
        { type: "turn_start" },
        {
          type: "tool_execution_start",
          toolCallId: "1",
          toolName: "read",
          args: { path: "counter.mjs" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "2",
          toolName: "read",
          args: { path: "counter.mjs" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "2",
          toolName: "read",
          isError: true,
        },
        { type: "auto_retry_start" },
        { type: "compaction_start" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            provider: "test",
            model: "model",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            usage: {
              input: 100,
              output: 5,
              cacheRead: 20,
              cacheWrite: 10,
              reasoning: 2,
              totalTokens: 135,
              cost: {
                input: 0.1,
                output: 0.2,
                cacheRead: 0.01,
                cacheWrite: 0.02,
                total: 0.33,
              },
            },
          },
        },
      ]),
      250,
    );
    expect(trace.providerRequests).toBe(1);
    expect(trace.usage.providerInput).toBe(130);
    expect(trace.usage.reasoning).toBe(2);
    expect(trace.usage.cost.total).toBeCloseTo(0.33);
    expect(trace.toolCalls).toBe(2);
    expect(trace.toolErrors).toBe(1);
    expect(trace.duplicateToolCalls).toBe(1);
    expect(trace.retries).toBe(1);
    expect(trace.compactions).toBe(1);
  });

  test("extracts projection and task-state audits without model content", () => {
    const session = analyzeSession(
      lines([
        { type: "session", version: 3 },
        {
          type: "custom",
          customType: "agent-context-card-audit",
          data: {
            hotEvidence: [],
            continuity: { taskId: "ACCEVAL-101", planRevision: 1 },
          },
        },
        {
          type: "custom",
          customType: "agent-context-card-task-state-audit",
          data: { operation: "load", status: "success" },
        },
      ]),
    );
    expect(session.projections).toHaveLength(1);
    expect(session.taskState).toEqual([
      { operation: "load", status: "success" },
    ]);
    expect(summarizeAudits([session])).toMatchObject({
      projectionRequests: 1,
      firstRequestHotEvidence: 0,
      planRevisions: [1],
      taskState: { "load:success": 1 },
    });
  });

  test("aggregates turns and reports directional percentage change", () => {
    const first = analyzeTrace(
      lines([
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: "x",
            usage: {
              input: 100,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 110,
              cost: { total: 1 },
            },
          },
        },
      ]),
    );
    const aggregate = aggregateTurns([{ trace: first }, { trace: first }]);
    expect(aggregate.providerRequests).toBe(2);
    expect(aggregate.usage.providerInput).toBe(200);
    expect(percentChange(200, 100)).toBe(-50);
  });

  test("reports malformed JSON lines instead of dropping them silently", () => {
    const parsed = parseJsonLines('{"type":"ok"}\nnot-json');
    expect(parsed.records).toHaveLength(1);
    expect(parsed.errors[0].line).toBe(2);
  });

  test("counts provider failures separately from tool failures", () => {
    const trace = analyzeTrace(
      lines([
        {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "429 session usage limit",
            usage: {},
          },
        },
      ]),
    );
    expect(trace.providerErrors).toBe(1);
    expect(trace.toolErrors).toBe(0);
    expect(aggregateTurns([{ trace }]).providerErrors).toBe(1);
  });
});

describe("SWE-bench evaluation", () => {
  test("removes private task state and all carriage returns", () => {
    const patch = [
      "diff --git a/.agent-context-card/tasks/x.json b/.agent-context-card/tasks/x.json\r\n",
      "+private\r\n",
      "diff --git a/src.py b/src.py\r\n",
      "@@ -1 +1 @@\r\n",
      "-old\r\n",
      "+new\r\n",
    ].join("");
    const result = sanitizePatch(patch);
    expect(result).not.toContain(".agent-context-card");
    expect(result).not.toContain("\r");
    expect(result).toContain("diff --git a/src.py b/src.py");
  });

  test("parses official resolution and test counts", () => {
    const summary = summarizeOfficialReport(
      [
        {
          data: {
            "owner__repo-1": {
              patch_successfully_applied: true,
              resolved: true,
              tests_status: {
                FAIL_TO_PASS: { success: ["a"], failure: [] },
                PASS_TO_PASS: { success: ["b", "c"], failure: [] },
              },
            },
          },
        },
      ],
      "owner__repo-1",
    );
    expect(summary).toEqual({
      completed: true,
      patchApplied: true,
      resolved: true,
      failToPass: { success: 1, failure: 0 },
      passToPass: { success: 2, failure: 0 },
    });
  });
});
