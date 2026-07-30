import { describe, expect, test } from "bun:test";
import {
  splitPlanContent,
  extractPhaseLimitedDirectives,
} from "../src/core/continuity";

describe("plan scope directive extraction", () => {
  test("extracts phase-limited directives based on negation and mutation verbs", () => {
    const inputs = [
      {
        text: "Do not modify any files during this phase.",
        shouldExtract: true,
      },
      {
        text: "Avoid editing the source code until planning is complete.",
        shouldExtract: true,
      },
      {
        text: "You must not change any logic in this step.",
        shouldExtract: true,
      },
      {
        text: "Should not touch the config files yet.",
        shouldExtract: true,
      },
      {
        text: "Don't write to the disk until the end.",
        shouldExtract: true,
      },
      {
        text: "Please modify the file carefully.",
        shouldExtract: false,
      },
      {
        text: "I will edit the file in the next step.",
        shouldExtract: false,
      },
      {
        text: "The plan involves changing a few lines.",
        shouldExtract: false,
      },
      {
        text: "Do not forget to run the tests.",
        shouldExtract: false,
      },
    ];

    for (const { text, shouldExtract } of inputs) {
      const { body, extracted } = extractPhaseLimitedDirectives(text);
      if (shouldExtract) {
        expect(extracted).toContain(text);
        expect(body).toBe("");
      } else {
        expect(extracted).toEqual([]);
        expect(body).toBe(text);
      }
    }
  });

  test("handles multiple directives in a single block", () => {
    const text =
      "Step 1: Read files.\nDo not edit them yet.\nStep 2: Design.\nAvoid modifying core.ts.";
    const { body, extracted } = extractPhaseLimitedDirectives(text);
    expect(extracted).toEqual([
      "Do not edit them yet.",
      "Avoid modifying core.ts.",
    ]);
    expect(body).toBe("Step 1: Read files.\n\nStep 2: Design.");
  });
});

describe("splitPlanContent continuity with scope extraction", () => {
  test("Case (a): directive embedded inside ## Plan gets moved to scopeNotes", () => {
    const content =
      "## Plan\nDo not modify any files during this phase.\nImplement X.";
    const { body, scopeNotes } = splitPlanContent(content);
    expect(scopeNotes).toBe("Do not modify any files during this phase.");
    expect(body).toBe("Implement X.");
  });

  test("Case (b): directive under ## Process Notes still works as before", () => {
    const content =
      "## Plan\nImplement X.\n## Process Notes\nDo not modify any files.";
    const { body, scopeNotes } = splitPlanContent(content);
    expect(body).toBe("Implement X.");
    expect(scopeNotes).toBe("Do not modify any files.");
  });

  test("Case (c): plain mention of editing without negation is left untouched", () => {
    const content = "## Plan\nI will modify the files carefully.\nImplement X.";
    const { body, scopeNotes } = splitPlanContent(content);
    expect(body).toBe("I will modify the files carefully.\nImplement X.");
    expect(scopeNotes).toBeUndefined();
  });

  test("Case (d): plan with no headers and no directive is unaffected", () => {
    const content = "Just a simple plan.\nStep 1\nStep 2";
    const { body, scopeNotes } = splitPlanContent(content);
    expect(body).toBe(content);
    expect(scopeNotes).toBeUndefined();
  });

  test("Case (e): oversize combined scope notes fall back to durable body", () => {
    const oversized = "a".repeat(600);
    const content = `## Plan\nDo not modify files.\n## Process Notes\n${oversized}`;
    const { body, scopeNotes } = splitPlanContent(content);
    // If combined scopeNotes > 500, everything falls back to body
    expect(scopeNotes).toBeUndefined();
    expect(body).toContain("Do not modify files.");
    expect(body).toContain(oversized);
  });

  test("no-op for clean plans", () => {
    const content = "## Plan\nStep 1: Read\nStep 2: Write";
    const { body, scopeNotes } = splitPlanContent(content);
    expect(body).toBe("Step 1: Read\nStep 2: Write");
    expect(scopeNotes).toBeUndefined();
  });
});
