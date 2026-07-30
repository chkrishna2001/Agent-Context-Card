export const CARD_MESSAGE_TYPE = "agent-context-card";
export const ANCHOR_ENTRY_TYPE = "agent-context-card-anchor";
export const AUDIT_ENTRY_TYPE = "agent-context-card-audit";
export const PLAN_ENTRY_TYPE = "agent-context-card-plan";
export const RESUME_ENTRY_TYPE = "agent-context-card-resume";
export const TASK_STATE_AUDIT_ENTRY_TYPE =
  "agent-context-card-task-state-audit";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  toolName: string;
  isError: boolean;
}

export interface ContextMessage<TRaw = unknown> {
  raw: TRaw;
  toolOnlyRaw?: TRaw;
  role: "user" | "assistant" | "toolResult" | "other";
  text: string;
  toolCalls: ToolCall[];
  toolResult?: ToolResult;
}

export interface TaskAnchor {
  goal: string;
  createdAtTurn: number;
}

export interface TaskAnchorDetails {
  anchor: TaskAnchor;
  reset: boolean;
}

export interface PinnedPlan {
  content: string;
  scopeNotes?: string;
  revision: number;
  sourceTurn: number;
  capturedAt: string;
}

export interface PlanCandidate {
  content: string;
  scopeNotes?: string;
  sourceTurn: number;
  capturedAt: string;
}

export interface PlanStateDetails {
  taskId?: string;
  plan?: PinnedPlan;
  candidate?: PlanCandidate;
}

export interface ProjectCapabilities {
  projectType?: string;
  packageName?: string;
  packageManager?: string;
  documentation: string[];
  validation: string[];
}

export type ExecutionKind = "change" | "validation" | "other";

export interface ExecutionRecord {
  action: string;
  kind: ExecutionKind;
  status: "success" | "failed";
  count: number;
  detail?: string;
}

export interface ExecutionJournal {
  changes: ExecutionRecord[];
  failures: ExecutionRecord[];
}

export interface RuntimeCard {
  goal: string;
  taskId?: string;
  latestRequest?: string;
  capabilities: ProjectCapabilities;
  execution: ExecutionJournal;
  plan?: PinnedPlan;
  resumed?: {
    execution: ExecutionJournal;
    repositoryChanged: boolean;
  };
}

export type PlanProjectionMode = "full" | "phase-aware";
export type PlanProjectionState = "none" | "full" | "retired";
export type PlanPhaseFramingMode = "off" | "scope-note";
export type PlanPhaseFramingState =
  "none" | "disabled" | "planning" | "post-planning";

export interface RepositoryProvenance {
  root: string;
  head?: string;
  worktree: string;
}

export interface TaskSnapshot {
  schemaVersion: 1;
  taskId: string;
  anchor: TaskAnchor;
  plan?: PinnedPlan;
  candidate?: PlanCandidate;
  execution: ExecutionJournal;
  provenance: RepositoryProvenance;
  updatedAt: string;
}

export interface TaskStateAudit {
  operation: "load" | "save" | "close" | "gc" | "session" | "resume-check";
  status: "success" | "missing" | "corrupt" | "failed" | "info" | "skipped";
  taskId?: string;
  detail?: string;
  timestamp: string;
}

export interface ResumeStateDetails {
  snapshot: TaskSnapshot;
}

export interface EvidenceLease {
  path: string;
  version: string;
  state: "active" | "consumed";
  toolCallId: string;
}

export interface RetirementCounts {
  duplicate: number;
  discovery: number;
  staleRead: number;
  completedTurn: number;
}

export interface ProjectionResult<TRaw = unknown> {
  messages: TRaw[];
  retiredMessages: number;
  retiredTurns: number;
  originalChars: number;
  projectedChars: number;
  retired: RetirementCounts;
  hotEvidence: EvidenceLease[];
}

export interface ProjectionAudit {
  turn: number;
  request: number;
  model?: string;
  contextWindow?: number;
  estimatedProjectedTokens: number;
  projectedWindowPercent?: number;
  cardChars: number;
  originalMessages: number;
  projectedMessages: number;
  originalChars: number;
  projectedChars: number;
  retiredMessages: number;
  retiredTurns: number;
  retired: RetirementCounts;
  hotEvidence: EvidenceLease[];
  retiredProcessNotes?: string;
  invariantViolations?: import("./invariants").InvariantViolation[];
  continuity?: {
    taskId?: string;
    planRevision?: number;
    planProjectionMode?: PlanProjectionMode;
    planProjectionState?: PlanProjectionState;
    planPhaseFramingMode?: PlanPhaseFramingMode;
    planPhaseFramingState?: PlanPhaseFramingState;
    planChars: number;
    resumedChanges: number;
    resumedFailures: number;
    repositoryChanged: boolean;
  };
}

export const emptyAnchor = (): TaskAnchor => ({
  goal: "",
  createdAtTurn: -1,
});

export const emptyExecutionJournal = (): ExecutionJournal => ({
  changes: [],
  failures: [],
});
