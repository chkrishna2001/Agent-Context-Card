import { isPlanningRequest } from "./continuity";
import type {
  CardFinding,
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

function formatChange(record: { action: string; count: number }): string {
  return record.count > 1 ? `${record.action} ×${record.count}` : record.action;
}

function formatFailure(record: { action: string; detail?: string }): string {
  return record.detail ? `${record.action} — ${record.detail}` : record.action;
}

function formatFinding(finding: CardFinding): string {
  // Naming the source(s) marks this as a synthesis of files already read,
  // not a fresh claim needing independent verification - the same
  // distinction a full transcript gives for free by leaving the original
  // read visible. Without it, a finding reads as an assertion with no
  // stated basis, which is a plausible reason a model re-runs its own
  // already-confirmed conclusion instead of trusting the card's record of it.
  const provenance = finding.sources?.length
    ? ` (from ${finding.sources.join(", ")})`
    : "";
  return `${finding.topic}: ${finding.detail}${provenance}`;
}

function formatProject(card: RuntimeCard): string | undefined {
  const description = card.capabilities.description?.trim();
  if (description) return description;
  if (card.capabilities.packageName && card.capabilities.projectType)
    return `${card.capabilities.packageName} (${card.capabilities.projectType})`;
  if (card.capabilities.packageName) return card.capabilities.packageName;
  if (card.capabilities.projectType) return card.capabilities.projectType;
  return undefined;
}

function projectCapabilitiesSection(card: RuntimeCard): string[] {
  const rows: string[] = [];
  const type = card.capabilities.projectType
    ? `Type: ${card.capabilities.projectType}`
    : "";
  const pkg = card.capabilities.packageName
    ? `Package: ${card.capabilities.packageName}${
        card.capabilities.packageManager
          ? ` (${card.capabilities.packageManager})`
          : ""
      }`
    : "";
  const docs = card.capabilities.documentation.length
    ? `Documentation: ${card.capabilities.documentation.join(", ")}`
    : "";
  const validate = card.capabilities.validation.length
    ? `Validation: ${card.capabilities.validation.join(", ")}`
    : "";
  for (const row of [type, pkg, docs, validate]) if (row) rows.push(row);
  return rows;
}

// The card is the provider prefix's first message, so any byte that changes
// here invalidates every cached token behind it. Keep it fixed for the task:
// per-turn values (latest request, repository HEAD) belong in
// formatCardStatus, never here.
export function formatContextCard(
  card: RuntimeCard,
  options: FormatContextCardOptions = {},
): string {
  const lines = ["<context-card>"];
  if (card.goal) lines.push(`goal: ${card.goal}`);
  if (card.taskId) lines.push(`TASK ID: ${card.taskId}`);

  const project = formatProject(card);
  if (project) lines.push(`project: ${project}`);
  if (card.repo) lines.push(`repo: ${card.repo.root}`);

  if (card.plan) {
    if (planProjectionState(card, options) === "retired")
      lines.push(
        `PLAN STATE (revision ${card.plan.revision}): verified change and validation recorded; full plan body retired from this phase.`,
      );
    else {
      lines.push(`PINNED PLAN (revision ${card.plan.revision}):`);
      const framing = planPhaseFramingState(card, options);
      if (framing === "post-planning") {
        if (card.plan.scopeNotes) {
          lines.push(`  PROCESS NOTES RETIRED AT IMPLEMENTATION START`);
        } else {
          // Fallback to original scope-note framing if no specific notes were captured
          lines.push(
            "  PHASE NOTE: This plan was written during planning. The current request is post-planning; constraints scoped only to planning (for example, not modifying files while planning) no longer apply. The plan body is preserved verbatim below.",
          );
        }
      } else if (framing === "planning" && card.plan.scopeNotes) {
        lines.push(`  PROCESS NOTES:`);
        for (const line of card.plan.scopeNotes.split(/\r?\n/))
          lines.push(`    ${line}`);
      }
      for (const line of card.plan.content.split(/\r?\n/))
        lines.push(`  ${line}`);
    }
  }

  const capabilityRows = projectCapabilitiesSection(card);
  if (capabilityRows.length) {
    lines.push(`PROJECT CAPABILITIES:`);
    for (const row of capabilityRows) lines.push(`- ${row}`);
  }

  lines.push("</context-card>");
  return lines.join("\n");
}

// Everything here changes between turns: latest request, repository HEAD,
// execution changes, pending items, findings, file-read leases, failures,
// resumed facts. The header above (goal, plan, capabilities) stays fixed for
// the whole task, so callers place this as a separate message right after the
// turn's user request and keep it unchanged until the next request - that
// keeps the history before it a valid cacheable prefix, and lets every later
// request in the turn extend that prefix instead of replacing its tail.
export function formatCardStatus(card: RuntimeCard): string {
  const lines: string[] = [];

  if (card.latestRequest && card.latestRequest !== card.goal)
    lines.push(`LATEST REQUEST: ${card.latestRequest}`);
  if (card.repo?.head) lines.push(`repo HEAD: ${card.repo.head.slice(0, 8)}`);

  if (card.execution.changes.length) {
    lines.push(
      `what happened: ${card.execution.changes.map(formatChange).join("; ")}`,
    );
  }
  if (card.pending && card.pending.length) {
    lines.push(`what's pending: ${card.pending.join("; ")}`);
  }
  if (card.findings && card.findings.length) {
    lines.push(`findings: ${card.findings.map(formatFinding).join("; ")}`);
  }
  // Active entries duplicate content already visible in the projected
  // transcript itself; only non-active entries (e.g. consumed) tell the
  // model something it can no longer see directly.
  const nonActiveFilesRead = card.filesRead?.filter(
    (entry) => entry.state !== "active",
  );
  if (nonActiveFilesRead && nonActiveFilesRead.length) {
    lines.push(
      `files read: ${nonActiveFilesRead
        .map((entry) => `${entry.path} (${entry.state})`)
        .join(", ")}`,
    );
  }
  if (card.execution.failures.length) {
    lines.push(
      `failures: ${card.execution.failures.map(formatFailure).join("; ")}`,
    );
  }

  if (card.resumed) {
    if (card.resumed.repositoryChanged)
      lines.push(
        "REPOSITORY STATE CHANGED SINCE THE PRIOR SESSION; prior validations are historical.",
      );
    const priorFailures = card.resumed.execution.failures
      .map(formatFailure)
      .filter(Boolean);
    if (priorFailures.length) {
      lines.push(`PRIOR SESSION UNRESOLVED FAILURES:`);
      for (const failure of priorFailures) lines.push(`- ${failure}`);
    }
    const priorChanges = card.resumed.execution.changes
      .map(formatChange)
      .filter(Boolean);
    if (priorChanges.length) {
      lines.push(`PRIOR SESSION VERIFIED FACTS:`);
      for (const change of priorChanges) lines.push(`- ${change}`);
    }
  }

  if (lines.length === 0) return "";
  return ["<context-card-status>", ...lines, "</context-card-status>"].join(
    "\n",
  );
}
