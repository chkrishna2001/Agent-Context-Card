import { describe, expect, test } from "bun:test";
import { splitPlanContent } from "../src/core/continuity";
import { formatContextCard, planPhaseFramingState } from "../src/core/format";

describe("plan content splitting (Sizing Guard)", () => {
  test("Case 1: Header present, constraint retires on transition", () => {
    const content = "## Plan\nStep 1\n## Process Notes\nShort note";
    const { body, scopeNotes } = splitPlanContent(content);
    expect(body).toBe("Step 1");
    expect(scopeNotes).toBe("Short note");
  });

  test("Case 2: No header at all -> whole block stays durable", () => {
    const content = "This is a plan without headers\nStep 1\nNote A";
    const { body, scopeNotes } = splitPlanContent(content);
    expect(body).toBe(content);
    expect(scopeNotes).toBeUndefined();
  });

  test("Case 3: Header present but oversized -> falls back to durable", () => {
    const oversized = "a".repeat(501);
    const content = `## Plan\nStep 1\n## Process Notes\n${oversized}`;
    const { body, scopeNotes } = splitPlanContent(content);
    expect(body).toContain(oversized);
    expect(scopeNotes).toBeUndefined();
  });

  test("Case 4: Durable constraint under ## Plan survives", () => {
    const content = "## Plan\nDo not deploy before tests pass\nStep 1\n## Process Notes\nShort note";
    const { body, scopeNotes } = splitPlanContent(content);
    expect(body).toContain("Do not deploy before tests pass");
    expect(scopeNotes).toBe("Short note");
  });
});

describe("plan projection visibility", () => {
  test("Case 5: Phase transition marker appears and content retires", () => {
    const runtimeCard = {
      goal: "Task",
      latestRequest: "Implement now",
      capabilities: { documentation: [], validation: [] },
      execution: { changes: [], failures: [] },
      plan: {
        content: "Step 1",
        revision: 1,
        sourceTurn: 0,
        capturedAt: "2026-01-01T00:00:00Z",
        scopeNotes: "Retire me",
      },
    };
    const card = formatContextCard(runtimeCard, { planPhaseFramingMode: "scope-note" });
    
    expect(planPhaseFramingState(runtimeCard, { planPhaseFramingMode: "scope-note" })).toBe("post-planning");
    expect(card).toContain("PROCESS NOTES RETIRED AT IMPLEMENTATION START");
    expect(card).not.toContain("Retire me");
  });
});
