import type {
  ExecutionJournal,
  ExecutionRecord,
  PinnedPlan,
  PlanCandidate,
  RepositoryProvenance,
  TaskSnapshot,
} from "./types";

const TASK_ID_PATTERN =
  /\b(?:[A-Z][A-Z0-9]{0,15}-\d+|[a-z0-9][a-z0-9._-]{0,63}__[a-z0-9][a-z0-9._-]{0,63}-\d+)\b/g;

export function taskIdFromInput(text: string): string | undefined {
  return text.match(TASK_ID_PATTERN)?.[0];
}

export function isPlanningRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return (
    /^(?:please\s+)?(?:plan|replan|re-plan)\b/i.test(normalized) ||
    /\b(?:create|draft|produce|write|make|revise|update|rework)\s+(?:an?\s+|the\s+)?(?:implementation\s+)?plan\b/i.test(
      normalized,
    ) ||
    /\b(?:can|could|would)\s+you\s+(?:please\s+)?plan\b/i.test(normalized)
  );
}

const PLAN_HEADER = "## Plan";
const PROCESS_NOTES_HEADER = "## Process Notes";
const PROCESS_NOTES_MAX_CHARS = 500;

export function extractPhaseLimitedDirectives(text: string): {
  body: string;
  extracted: string[];
} {
  const negationPatterns = [
    /do not/i,
    /don't/i,
    /avoid/i,
    /must not/i,
    /should not/i,
  ];
  const mutationVerbs = [/modify/i, /edit/i, /change/i, /touch/i, /write/i];

  const lines = text.split("\n");
  const extracted: string[] = [];
  const remaining: string[] = [];

  for (const line of lines) {
    const hasNegation = negationPatterns.some((p) => p.test(line));
    const hasMutation = mutationVerbs.some((p) => p.test(line));

    if (hasNegation && hasMutation) {
      extracted.push(line);
    } else {
      remaining.push(line);
    }
  }

  return {
    body: remaining.filter((l) => l.trim() !== "").join("\n\n"),
    extracted,
  };
}

export function splitPlanContent(content: string): {
  body: string;
  scopeNotes: string | undefined;
} {
  const planIndex = content.indexOf(PLAN_HEADER);
  const notesIndex = content.indexOf(PROCESS_NOTES_HEADER);

  if (planIndex === -1 && notesIndex === -1) {
    return { body: content, scopeNotes: undefined };
  }

  const firstHeaderIndex = Math.min(
    planIndex === -1 ? Infinity : planIndex,
    notesIndex === -1 ? Infinity : notesIndex,
  );

  const preamble = content.slice(0, firstHeaderIndex).trim();

  let body = "";
  let scopeNotes: string | undefined = undefined;
  let notesOversized = false;

  if (planIndex !== -1) {
    const planStart = planIndex + PLAN_HEADER.length;
    const nextHeader = findNextHeader(content, planStart);
    body = content.slice(planStart, nextHeader).trim();
  }

  if (notesIndex !== -1) {
    const notesStart = notesIndex + PROCESS_NOTES_HEADER.length;
    const nextHeader = findNextHeader(content, notesStart);
    const notesContent = content.slice(notesStart, nextHeader).trim();

    if (notesContent.length > PROCESS_NOTES_MAX_CHARS) {
      // Oversize fallback: treat as part of the durable plan body. A combined
      // scopeNotes can never fit under the limit once Process Notes alone
      // already exceeds it, so directive extraction below is skipped too.
      body =
        (body ? `${body}\n\n` : "") +
        `${PROCESS_NOTES_HEADER}\n${notesContent}`;
      notesOversized = true;
    } else {
      scopeNotes = notesContent || undefined;
    }
  }

  if (preamble) {
    body = body ? `${preamble}\n\n${body}` : preamble;
  }

  if (!notesOversized) {
    const { body: filteredBody, extracted } =
      extractPhaseLimitedDirectives(body);
    if (extracted.length > 0) {
      const combinedNotes = scopeNotes
        ? `${scopeNotes}\n${extracted.join("\n")}`
        : extracted.join("\n");

      if (combinedNotes.length <= PROCESS_NOTES_MAX_CHARS) {
        body = filteredBody;
        scopeNotes = combinedNotes;
      }
      // Otherwise combinedNotes would exceed the limit: leave body and
      // scopeNotes untouched so directives stay in their original form.
    }
  }

  return { body, scopeNotes };
}

function findNextHeader(content: string, start: number): number {
  const headers = [PLAN_HEADER, PROCESS_NOTES_HEADER];
  let minIndex = content.length;
  for (const header of headers) {
    const index = content.indexOf(header, start);
    if (index !== -1 && index < minIndex) {
      minIndex = index;
    }
  }
  return minIndex;
}

export function promotePlan(
  candidate: PlanCandidate,
  current?: PinnedPlan,
): PinnedPlan {
  return {
    ...candidate,
    revision: (current?.revision ?? 0) + 1,
  };
}

function currentActions(journal: ExecutionJournal): Set<string> {
  return new Set(
    [...journal.changes, ...journal.failures].map((record) => record.action),
  );
}

export function unresolvedPriorExecution(
  prior: ExecutionJournal,
  current: ExecutionJournal,
): ExecutionJournal {
  const replaced = currentActions(current);
  return {
    changes: prior.changes.filter((record) => !replaced.has(record.action)),
    failures: prior.failures.filter((record) => !replaced.has(record.action)),
  };
}

export function mergeExecutionJournals(
  prior: ExecutionJournal,
  current: ExecutionJournal,
): ExecutionJournal {
  const remaining = unresolvedPriorExecution(prior, current);
  return {
    changes: [...remaining.changes, ...current.changes],
    failures: [...remaining.failures, ...current.failures],
  };
}

function executionRecord(value: unknown): value is ExecutionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ExecutionRecord>;
  return (
    typeof record.action === "string" &&
    ["change", "validation", "other"].includes(String(record.kind)) &&
    ["success", "failed"].includes(String(record.status)) &&
    typeof record.count === "number"
  );
}

function journal(value: unknown): value is ExecutionJournal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ExecutionJournal>;
  return (
    Array.isArray(candidate.changes) &&
    candidate.changes.every(executionRecord) &&
    Array.isArray(candidate.failures) &&
    candidate.failures.every(executionRecord)
  );
}

function provenance(value: unknown): value is RepositoryProvenance {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RepositoryProvenance>;
  return (
    typeof candidate.root === "string" &&
    typeof candidate.worktree === "string" &&
    (candidate.head === undefined || typeof candidate.head === "string")
  );
}

function plan(value: unknown): value is PinnedPlan {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PinnedPlan>;
  return (
    typeof candidate.content === "string" &&
    typeof candidate.revision === "number" &&
    typeof candidate.sourceTurn === "number" &&
    typeof candidate.capturedAt === "string"
  );
}

function planCandidate(value: unknown): value is PlanCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PlanCandidate>;
  return (
    typeof candidate.content === "string" &&
    typeof candidate.sourceTurn === "number" &&
    typeof candidate.capturedAt === "string"
  );
}

export function parseTaskSnapshot(value: unknown): TaskSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TaskSnapshot>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.taskId !== "string" ||
    !candidate.anchor ||
    typeof candidate.anchor.goal !== "string" ||
    typeof candidate.anchor.createdAtTurn !== "number" ||
    !journal(candidate.execution) ||
    !provenance(candidate.provenance) ||
    typeof candidate.updatedAt !== "string" ||
    (candidate.plan !== undefined && !plan(candidate.plan)) ||
    (candidate.candidate !== undefined && !planCandidate(candidate.candidate))
  )
    return undefined;
  return candidate as TaskSnapshot;
}

export function sameRepositoryState(
  left: RepositoryProvenance,
  right: RepositoryProvenance,
): boolean {
  return (
    left.root === right.root &&
    left.head === right.head &&
    left.worktree === right.worktree
  );
}
