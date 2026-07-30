import { describe, expect, test } from "bun:test";
import { RuntimeCard } from "../src/core/types";
import { checkCardInvariants } from "../src/core/invariants";

describe("card invariants", () => {
  const baseCard: RuntimeCard = {
    goal: "Implement the login fix",
    capabilities: { documentation: [], validation: [] },
    execution: { changes: [], failures: [] },
  };

  test("stale-plan-directive: detected when not a planning request", () => {
    const card: RuntimeCard = {
      ...baseCard,
      latestRequest: "Implement the login fix",
      plan: {
        content: "1. Inspect\nDo not modify any files.\n2. Implement",
        revision: 1,
        sourceTurn: 0,
        capturedAt: "2026-07-23T00:00:00.000Z",
      },
    };
    const violations = checkCardInvariants(card);
    expect(violations).toContainEqual({
      rule: "stale-plan-directive",
      detail: "Do not modify any files.",
    });
  });

  test("stale-plan-directive: not detected during planning request", () => {
    const card: RuntimeCard = {
      ...baseCard,
      latestRequest: "Please plan the login fix",
      plan: {
        content: "1. Inspect\nDo not modify any files.\n2. Implement",
        revision: 1,
        sourceTurn: 0,
        capturedAt: "2026-07-23T00:00:00.000Z",
      },
    };
    const violations = checkCardInvariants(card);
    expect(violations.filter((v) => v.rule === "stale-plan-directive")).toEqual(
      [],
    );
  });

  test("clean RuntimeCard produces zero violations", () => {
    const card: RuntimeCard = {
      ...baseCard,
      latestRequest: "Implement the login fix",
      plan: {
        content: "1. Inspect\n2. Implement",
        revision: 1,
        sourceTurn: 0,
        capturedAt: "2026-07-23T00:00:00.000Z",
      },
    };
    const violations = checkCardInvariants(card);
    expect(violations).toEqual([]);
  });

  test("unresolved-failure-has-matching-change: detected when failure is not resolved", () => {
    const card: RuntimeCard = {
      ...baseCard,
      execution: {
        changes: [
          {
            action: "run bun test",
            kind: "validation",
            status: "success",
            count: 1,
          },
        ],
        failures: [
          {
            action: "run bun test",
            kind: "validation",
            status: "failed",
            count: 1,
          },
        ],
      },
    };
    const violations = checkCardInvariants(card);
    expect(violations).toContainEqual({
      rule: "unresolved-failure-has-matching-change",
      detail: "run bun test",
    });
  });

  test("no plan produces zero violations", () => {
    const card: RuntimeCard = {
      ...baseCard,
      latestRequest: "Implement the login fix",
    };
    const violations = checkCardInvariants(card);
    expect(violations).toEqual([]);
  });
});
