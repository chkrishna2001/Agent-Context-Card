import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  aggregateTurns,
  analyzeSession,
  analyzeTrace,
  parseJsonLines,
  percentChange,
  summarizeAudits,
  summarizeRepeatedRuns,
} from "../scripts/evaluation/metrics.mjs";
import {
  sanitizePatch,
  summarizeOfficialReport,
} from "../scripts/evaluation/swebench.mjs";

const lines = (values: unknown[]) =>
  values.map((value) => JSON.stringify(value)).join("\n");

describe("evaluation metrics", () => {
  test("keeps the checked-in evidence ledger internally consistent", () => {
    const ledger = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dir,
          "..",
          "evaluation",
          "results",
          "evidence-ledger.json",
        ),
        "utf8",
      ),
    );
    expect(ledger.schemaVersion).toBe(1);
    expect(new Set(ledger.results.map((result: any) => result.id)).size).toBe(
      ledger.results.length,
    );
    for (const result of ledger.results) {
      expect(result.claimable).toBe(true);
      for (const [metric, reported] of Object.entries(result.changePercent)) {
        const baseline = result.baseline[metric];
        const card = result.card[metric];
        if (baseline === null || card === null || baseline === 0) {
          expect(reported).toBeNull();
          continue;
        }
        const calculated = ((card - baseline) / baseline) * 100;
        expect(reported).toBe(Number(calculated.toFixed(1)));
      }
    }
    const median = (values: number[]) => {
      const sorted = values.toSorted((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)];
    };
    for (const result of ledger.repeatedResults) {
      expect(result.claimable).toBe(true);
      expect(result.pairs).toHaveLength(3);
      for (const [metric, reported] of Object.entries(
        result.pairedChangePercent,
      )) {
        const changes = result.pairs.map((pair: any) =>
          Number(
            (
              ((pair.card[metric] - pair.baseline[metric]) /
                pair.baseline[metric]) *
              100
            ).toFixed(1),
          ),
        );
        expect(reported).toEqual({
          median: median(changes),
          min: Math.min(...changes),
          max: Math.max(...changes),
        });
      }
    }
    expect(
      ledger.excludedDiagnostics.every(
        (result: any) => result.claimable === false && result.reason,
      ),
    ).toBe(true);
  });

  test("defines the mixed live gate as ten isolated sessions", () => {
    const config = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dir,
          "..",
          "evaluation",
          "configs",
          "pi-ten-turn-mixed.json",
        ),
        "utf8",
      ),
    );
    expect(config.turns).toHaveLength(10);
    expect(new Set(config.turns.map((turn: any) => turn.name)).size).toBe(10);
    expect(
      config.turns.filter((turn: any) => turn.expect.snapshotPlanContains),
    ).toHaveLength(2);
    expect(config.variants.map((variant: any) => variant.name)).toEqual([
      "baseline",
      "card",
    ]);
  });

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
    expect(trace.sameStateDuplicateToolCalls).toBe(1);
    expect(trace.retries).toBe(1);
    expect(trace.compactions).toBe(1);
  });

  test("separates raw repeats from calls repeated without a relevant edit", () => {
    const trace = analyzeTrace(
      lines([
        {
          type: "tool_execution_start",
          toolCallId: "read-1",
          toolName: "read",
          args: { path: "counter.mjs" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "edit-1",
          toolName: "edit",
          args: { path: "counter.mjs", edits: [] },
        },
        {
          type: "tool_execution_end",
          toolCallId: "edit-1",
          toolName: "edit",
          isError: false,
        },
        {
          type: "tool_execution_start",
          toolCallId: "read-2",
          toolName: "read",
          args: { path: "counter.mjs" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "test-1",
          toolName: "bash",
          args: { command: "npm test" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "edit-2",
          toolName: "edit",
          args: { path: "counter.mjs", edits: [] },
        },
        {
          type: "tool_execution_end",
          toolCallId: "edit-2",
          toolName: "edit",
          isError: false,
        },
        {
          type: "tool_execution_start",
          toolCallId: "test-2",
          toolName: "bash",
          args: { command: "npm test" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "bad-1",
          toolName: "read",
          args: { path: "wrong/counter.mjs" },
        },
        {
          type: "tool_execution_start",
          toolCallId: "edit-3",
          toolName: "edit",
          args: { path: "counter.mjs", edits: [] },
        },
        {
          type: "tool_execution_end",
          toolCallId: "edit-3",
          toolName: "edit",
          isError: false,
        },
        {
          type: "tool_execution_start",
          toolCallId: "bad-2",
          toolName: "read",
          args: { path: "wrong/counter.mjs" },
        },
      ]),
    );
    expect(trace.duplicateToolCalls).toBe(5);
    expect(trace.sameStateDuplicateToolCalls).toBe(1);
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

  test("summarizes repeated runs with paired distributions", () => {
    const run = (variant: string, repeat: number, input: number) => ({
      variant,
      repeat,
      correct: true,
      aggregate: {
        usage: { providerInput: input, totalTokens: input + 10, output: 10 },
        providerRequests: 2,
        toolCalls: 1,
        toolErrors: 0,
        duplicateToolCalls: 0,
        sameStateDuplicateToolCalls: 0,
        durationMs: input,
      },
    });
    const summary = summarizeRepeatedRuns([
      run("baseline", 1, 100),
      run("baseline", 2, 200),
      run("card", 1, 50),
      run("card", 2, 100),
    ]);
    expect(summary.variants.baseline.metrics.providerInputTokens).toMatchObject(
      {
        count: 2,
        min: 100,
        max: 200,
        median: 150,
      },
    );
    expect(summary.pairedChanges.providerInputTokens).toMatchObject({
      count: 2,
      median: -50,
    });
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
