import { isPlanningRequest } from "./continuity";
import type {
  PlanPhaseFramingMode,
  PlanPhaseFramingState,
  PlanProjectionMode,
  PlanProjectionState,
  RuntimeCard,
} from "./types";

export interface FormatContextCardOptions {
  planProjectionMode?: PlanProjectionMode;
  planPhaseFramingMode?: PlanPhaseFramingMode;
}

function addList(lines: string[], title: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`${title}:`);
  for (const value of values) lines.push(`- ${value}`);
}

function verifiedImplementation(card: RuntimeCard): boolean {
  const changes = [
    ...(card.resumed?.execution.changes ?? []),
    ...card.execution.changes,
  ];
  return (
    changes.some((record) => record.kind === "change") &&
    changes.some((record) => record.kind === "validation")
  );
}

function needsFullPlan(request: string | undefined): boolean {
  if (!request) return true;
  return /\b(?:apply|build|continue|correct|debug|execute|fix|follow|implement|proceed|resume|review|test|validate)\b/i.test(
    request,
  );
}

export function planProjectionState(
  card: RuntimeCard,
  options: FormatContextCardOptions = {},
): PlanProjectionState {
  if (!card.plan) return "none";
  return options.planProjectionMode === "phase-aware" &&
    verifiedImplementation(card) &&
    !needsFullPlan(card.latestRequest)
    ? "retired"
    : "full";
}

export function planPhaseFramingState(
  card: RuntimeCard,
  options: FormatContextCardOptions = {},
): PlanPhaseFramingState {
  if (!card.plan) return "none";
  if (options.planPhaseFramingMode !== "scope-note") return "disabled";
  return card.latestRequest && !isPlanningRequest(card.latestRequest)
    ? "post-planning"
    : "planning";
}
export function formatContextCard(
  card: RuntimeCard,
  options: FormatContextCardOptions = {},
): string {
  const lines = ["<context-card>", `TASK: ${card.goal || "(unset)"}`];
  if (card.taskId) lines.push(`TASK ID: ${card.taskId}`);
  if (card.latestRequest && card.latestRequest !== card.goal)
    lines.push(`LATEST REQUEST: ${card.latestRequest}`);
  if (card.plan) {
    if (planProjectionState(card, options) === "retired")
      lines.push(
        `PLAN STATE (revision ${card.plan.revision}): verified change and validation recorded; full plan body retired from this phase.`,
      );
    else {
      lines.push(`PINNED PLAN (revision ${card.plan.revision}):`);
      if (planPhaseFramingState(card, options) === "post-planning")
        lines.push(
          "  PHASE NOTE: This plan was written during planning. The current request is post-planning; constraints scoped only to planning (for example, not modifying files while planning) no longer apply. The plan body is preserved verbatim below.",
        );
      for (const line of card.plan.content.split(/\r?\n/))
        lines.push(`  ${line}`);
    }
  }

  addList(
    lines,
    "PROJECT CAPABILITIES",
    [
      card.capabilities.projectType
        ? `Type: ${card.capabilities.projectType}`
        : "",
      card.capabilities.packageName
        ? `Package: ${card.capabilities.packageName}${card.capabilities.packageManager ? ` (${card.capabilities.packageManager})` : ""}`
        : "",
      card.capabilities.documentation.length
        ? `Documentation: ${card.capabilities.documentation.join(", ")}`
        : "",
      card.capabilities.validation.length
        ? `Validation: ${card.capabilities.validation.join(", ")}`
        : "",
    ].filter(Boolean),
  );
  if (card.resumed) {
    if (card.resumed.repositoryChanged)
      lines.push(
        "REPOSITORY STATE CHANGED SINCE THE PRIOR SESSION; prior validations are historical.",
      );
    addList(
      lines,
      "PRIOR SESSION UNRESOLVED FAILURES",
      card.resumed.execution.failures.map((record) =>
        record.detail ? `${record.action} — ${record.detail}` : record.action,
      ),
    );
    addList(
      lines,
      "PRIOR SESSION VERIFIED FACTS",
      card.resumed.execution.changes.map((record) =>
        record.count > 1 ? `${record.action} ×${record.count}` : record.action,
      ),
    );
  }
  addList(
    lines,
    "UNRESOLVED FAILURES",
    card.execution.failures.map((record) =>
      record.detail ? `${record.action} — ${record.detail}` : record.action,
    ),
  );
  addList(
    lines,
    "VERIFIED CHANGES",
    card.execution.changes.map((record) =>
      record.count > 1 ? `${record.action} ×${record.count}` : record.action,
    ),
  );
  lines.push("</context-card>");
  return lines.join("\n");
}
