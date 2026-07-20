export const CARD_MESSAGE_TYPE = "agent-context-card";
export const ANCHOR_ENTRY_TYPE = "agent-context-card-anchor";
export const AUDIT_ENTRY_TYPE = "agent-context-card-audit";

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
  latestRequest?: string;
  capabilities: ProjectCapabilities;
  execution: ExecutionJournal;
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
}

export const emptyAnchor = (): TaskAnchor => ({
  goal: "",
  createdAtTurn: -1,
});

export const emptyExecutionJournal = (): ExecutionJournal => ({
  changes: [],
  failures: [],
});
