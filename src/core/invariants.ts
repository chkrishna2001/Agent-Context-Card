import { isPlanningRequest, extractPhaseLimitedDirectives } from "./continuity";
import type { RuntimeCard } from "./types";

export interface InvariantViolation {
  rule: string;
  detail: string;
}

export function checkCardInvariants(card: RuntimeCard): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  // a. Plan-contradiction check
  if (card.plan) {
    const requestText = card.latestRequest ?? card.goal;
    if (!isPlanningRequest(requestText)) {
      const { extracted } = extractPhaseLimitedDirectives(card.plan.content);
      for (const line of extracted) {
        violations.push({
          rule: "stale-plan-directive",
          detail: line,
        });
      }
    }
  }

  // b. Failure/change consistency check
  for (const failure of card.execution.failures) {
    if (
      card.execution.changes.some((change) => change.action === failure.action)
    ) {
      violations.push({
        rule: "unresolved-failure-has-matching-change",
        detail: failure.action,
      });
    }
  }

  return violations;
}
