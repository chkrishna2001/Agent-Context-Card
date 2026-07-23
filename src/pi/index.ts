import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  createTaskAnchor,
  taskBoundaryForInput,
  taskGoalFromInput,
} from "../core/anchor";
import {
  isPlanningRequest,
  mergeExecutionJournals,
  promotePlan,
  sameRepositoryState,
  taskIdFromInput,
  unresolvedPriorExecution,
} from "../core/continuity";
import { buildExecutionJournal, isMutationToolName } from "../core/execution";
import {
  formatContextCard,
  planPhaseFramingState,
  planProjectionState,
} from "../core/format";
import { projectContext } from "../core/projection";
import { buildRuntimeCard } from "../core/runtime";
import {
  ANCHOR_ENTRY_TYPE,
  AUDIT_ENTRY_TYPE,
  CARD_MESSAGE_TYPE,
  emptyAnchor,
  emptyExecutionJournal,
  PLAN_ENTRY_TYPE,
  RESUME_ENTRY_TYPE,
  TASK_STATE_AUDIT_ENTRY_TYPE,
  type ExecutionJournal,
  type PinnedPlan,
  type PlanCandidate,
  type PlanPhaseFramingMode,
  type PlanProjectionMode,
  type PlanStateDetails,
  type ProjectionAudit,
  type RepositoryProvenance,
  type ResumeStateDetails,
  type TaskAnchor,
  type TaskAnchorDetails,
  type TaskSnapshot,
  type TaskStateAudit,
} from "../core/types";
import {
  messageText,
  normalizeMessages,
  scopeMessagesToGoal,
} from "./normalize";
import { repositoryProvenance, TaskStore } from "./task-store";

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function branchMessages(entries: SessionEntry[]): AgentMessage[] {
  let start = 0;
  entries.forEach((entry, index) => {
    if (entry.type !== "custom" || entry.customType !== ANCHOR_ENTRY_TYPE)
      return;
    const details = entry.data as TaskAnchorDetails | undefined;
    if (!details?.reset) return;
    const precedingUser = entries
      .slice(0, index)
      .findLastIndex(
        (candidate) =>
          candidate.type === "message" && candidate.message.role === "user",
      );
    start = precedingUser >= 0 ? precedingUser : index + 1;
  });
  return entries
    .slice(start)
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

export default function agentContextCard(pi: ExtensionAPI): void {
  let anchor: TaskAnchor = emptyAnchor();
  let currentTurn = 0;
  let latestRequest = "";
  let previousTurnSettled = false;
  let lastCard = "";
  let lastAudit: ProjectionAudit | undefined;
  let taskId: string | undefined;
  let plan: PinnedPlan | undefined;
  let planCandidate: PlanCandidate | undefined;
  let resumedExecution: ExecutionJournal = emptyExecutionJournal();
  let resumedProvenance: RepositoryProvenance | undefined;
  let store: TaskStore | undefined;
  let mayLoadCrossSession = false;
  let planningTurn = false;
  let turnMutated = false;

  const sessionIdOf = (ctx: ExtensionContext): string | undefined => {
    const sessionManager = ctx.sessionManager as
      | { getSessionId?: () => string }
      | undefined;
    try {
      return sessionManager?.getSessionId?.();
    } catch {
      return undefined;
    }
  };

  const taskAudit = (
    operation: TaskStateAudit["operation"],
    status: TaskStateAudit["status"],
    detail?: string,
  ): void =>
    pi.appendEntry<TaskStateAudit>(TASK_STATE_AUDIT_ENTRY_TYPE, {
      operation,
      status,
      taskId,
      detail,
      timestamp: new Date().toISOString(),
    });

  pi.registerFlag("context-card-recent-turns", {
    description: "Recent user turns retained verbatim (default: 2)",
    type: "string",
    default: "2",
  });
  pi.registerFlag("context-card-audit", {
    description:
      "Persist projection metrics outside model context: off or on (default: on)",
    type: "string",
    default: "on",
  });
  pi.registerFlag("context-card-plan-projection", {
    description:
      "Pinned-plan projection: full or phase-aware (experimental; default: full)",
    type: "string",
    default: "full",
  });
  pi.registerFlag("context-card-plan-framing", {
    description:
      "Planning-constraint framing: off or scope-note (experimental; default: off)",
    type: "string",
    default: "off",
  });

  const planPhaseFramingMode = (): PlanPhaseFramingMode =>
    pi.getFlag("context-card-plan-framing") === "scope-note"
      ? "scope-note"
      : "off";

  const planProjectionMode = (): PlanProjectionMode =>
    pi.getFlag("context-card-plan-projection") === "phase-aware"
      ? "phase-aware"
      : "full";

  const reconstruct = (ctx: ExtensionContext): void => {
    anchor = emptyAnchor();
    taskId = undefined;
    const branch = ctx.sessionManager.getBranch();
    plan = undefined;
    planCandidate = undefined;
    resumedExecution = emptyExecutionJournal();
    resumedProvenance = undefined;
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== ANCHOR_ENTRY_TYPE)
        continue;
      const details = entry.data as TaskAnchorDetails | undefined;
      if (details?.anchor) anchor = details.anchor;
    }
    for (const entry of branch) {
      if (entry.type !== "custom") continue;
      if (entry.customType === PLAN_ENTRY_TYPE) {
        const details = entry.data as PlanStateDetails | undefined;
        taskId = details?.taskId;
        plan = details?.plan;
        planCandidate = details?.candidate;
      }
      if (entry.customType === RESUME_ENTRY_TYPE) {
        const details = entry.data as ResumeStateDetails | undefined;
        if (!details?.snapshot) continue;
        taskId = details.snapshot.taskId;
        resumedExecution = details.snapshot.execution;
        resumedProvenance = details.snapshot.provenance;
      }
    }
    const messages = branchMessages(branch);
    currentTurn = messages.filter((message) => message.role === "user").length;
    latestRequest =
      messages
        .filter((message) => message.role === "user")
        .map((message) => taskGoalFromInput(messageText(message)))
        .filter(Boolean)
        .at(-1) ?? anchor.goal;
    const assistant = messages.findLast(
      (message) => message.role === "assistant",
    );
    previousTurnSettled =
      assistant?.role === "assistant" && assistant.stopReason === "stop";
    store = new TaskStore(ctx.cwd);
    mayLoadCrossSession = messages.length === 0;
  };

  const persistPlanState = (): void =>
    pi.appendEntry<PlanStateDetails>(PLAN_ENTRY_TYPE, {
      taskId,
      plan,
      candidate: planCandidate,
    });

  const saveTask = async (ctx: ExtensionContext): Promise<void> => {
    if (!taskId || !store || !anchor.goal) return;
    const current = buildExecutionJournal(
      normalizeMessages(branchMessages(ctx.sessionManager.getBranch())),
    );
    const snapshot: TaskSnapshot = {
      schemaVersion: 1,
      taskId,
      anchor,
      plan,
      candidate: planCandidate,
      execution: mergeExecutionJournals(resumedExecution, current),
      provenance: repositoryProvenance(ctx.cwd),
      updatedAt: new Date().toISOString(),
    };
    try {
      await store.save(snapshot);
      taskAudit("save", "success");
    } catch (error) {
      taskAudit("save", "failed", String(error));
    }
  };

  const runtimeCard = (
    ctx: ExtensionContext,
    normalized: ReturnType<typeof normalizeMessages>,
  ) => {
    const currentExecution = buildExecutionJournal(normalized);
    const priorExecution = unresolvedPriorExecution(
      resumedExecution,
      currentExecution,
    );
    const hasPriorExecution =
      priorExecution.changes.length > 0 || priorExecution.failures.length > 0;
    const currentProvenance = resumedProvenance
      ? repositoryProvenance(ctx.cwd)
      : undefined;
    return buildRuntimeCard(ctx.cwd, anchor.goal, normalized, {
      taskId,
      plan,
      resumed:
        hasPriorExecution && resumedProvenance && currentProvenance
          ? {
              execution: priorExecution,
              repositoryChanged: !sameRepositoryState(
                resumedProvenance,
                currentProvenance,
              ),
            }
          : undefined,
    });
  };

  const persistAnchor = (text: string, reset: boolean): boolean => {
    const next = createTaskAnchor(text, currentTurn);
    if (!next.goal) return false;
    anchor = next;
    pi.appendEntry<TaskAnchorDetails>(ANCHOR_ENTRY_TYPE, { anchor, reset });
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    reconstruct(ctx);
    try {
      const removed = await store?.collectGarbage();
      if (removed) taskAudit("gc", "success", `${removed} expired task(s)`);
    } catch (error) {
      taskAudit("gc", "failed", String(error));
    }
    const branch = ctx.sessionManager.getBranch();
    taskAudit(
      "session",
      "info",
      `sessionId=${sessionIdOf(ctx) ?? "unknown"}; branchEntries=${branch.length}; branchMessages=${branchMessages(branch).length}; mayLoadCrossSession=${String(mayLoadCrossSession)}`,
    );
  });
  pi.on("session_tree", async (_event, ctx) => {
    reconstruct(ctx);
    const branch = ctx.sessionManager.getBranch();
    taskAudit(
      "session",
      "info",
      `tree sessionId=${sessionIdOf(ctx) ?? "unknown"}; branchEntries=${branch.length}; branchMessages=${branchMessages(branch).length}; mayLoadCrossSession=${String(mayLoadCrossSession)}`,
    );
  });
  pi.on("input", async (event, ctx) => {
    const requestedId = taskIdFromInput(event.text);
    const sessionId = sessionIdOf(ctx) ?? "unknown";
    let resumed = false;
    if (mayLoadCrossSession) {
      taskAudit(
        "resume-check",
        "info",
        `sessionId=${sessionId}; reason=empty-branch; requestedId=${requestedId ?? "none"}`,
      );
      mayLoadCrossSession = false;
      if (!requestedId) {
        taskAudit(
          "resume-check",
          "skipped",
          `sessionId=${sessionId}; reason=no-task-id; input=${JSON.stringify(event.text)}`,
        );
      } else if (!store) {
        taskAudit(
          "resume-check",
          "skipped",
          `sessionId=${sessionId}; reason=no-store; taskId=${requestedId}`,
        );
      } else {
        taskId = requestedId;
        taskAudit(
          "resume-check",
          "info",
          `sessionId=${sessionId}; reason=attempt-load; taskId=${requestedId}`,
        );
        const loaded = await store.load(requestedId);
        if (loaded.status === "success") {
          const snapshot = loaded.snapshot;
          anchor = snapshot.anchor;
          plan = snapshot.plan;
          planCandidate = snapshot.candidate;
          resumedExecution = snapshot.execution;
          resumedProvenance = snapshot.provenance;
          pi.appendEntry<ResumeStateDetails>(RESUME_ENTRY_TYPE, { snapshot });
          pi.appendEntry<TaskAnchorDetails>(ANCHOR_ENTRY_TYPE, {
            anchor,
            reset: true,
          });
          persistPlanState();
          taskAudit("load", "success", `sessionId=${sessionId}; taskId=${requestedId}`);
          resumed = true;
        } else if (loaded.status === "missing") {
          taskAudit("load", "missing", `sessionId=${sessionId}; taskId=${requestedId}`);
        } else {
          taskAudit(
            "load",
            "corrupt",
            `sessionId=${sessionId}; taskId=${requestedId}; detail=${loaded.detail}`,
          );
          taskId = undefined;
        }
      }
    } else {
      taskAudit(
        "resume-check",
        "skipped",
        `sessionId=${sessionId}; reason=non-empty-branch; requestedId=${requestedId ?? "none"}`,
      );
    }

    planningTurn = isPlanningRequest(event.text);
    turnMutated = false;
    if (planCandidate && !planningTurn) {
      plan = promotePlan(planCandidate, plan);
      planCandidate = undefined;
      persistPlanState();
    }

    const boundary = taskBoundaryForInput(event.text, {
      goal: anchor.goal,
      latestRequest,
      settled: previousTurnSettled,
    });
    if (!resumed && (!anchor.goal || boundary === "new")) {
      if (boundary === "new" && anchor.goal) {
        plan = undefined;
        planCandidate = undefined;
        resumedExecution = emptyExecutionJournal();
        resumedProvenance = undefined;
        taskId = requestedId;
        persistPlanState();
      } else if (!taskId) {
        taskId = requestedId;
      }
      persistAnchor(event.text, true);
    }
    latestRequest = taskGoalFromInput(event.text);
    previousTurnSettled = false;
  });
  pi.on("tool_execution_end", (event) => {
    if (!event.isError && isMutationToolName(event.toolName))
      turnMutated = true;
  });
  pi.on("turn_end", async (event, ctx) => {
    previousTurnSettled =
      event.message.role === "assistant" && event.message.stopReason === "stop";
    if (previousTurnSettled && planningTurn && !turnMutated) {
      const content = messageText(event.message).trim();
      if (content) {
        planCandidate = {
          content,
          sourceTurn: currentTurn,
          capturedAt: new Date().toISOString(),
        };
        persistPlanState();
      }
    }
    if (previousTurnSettled) {
      currentTurn++;
      await saveTask(ctx);
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => saveTask(ctx));

  pi.on("context", async (event, ctx) => {
    const withoutCards = event.messages.filter(
      (message) =>
        !(
          message.role === "custom" && message.customType === CARD_MESSAGE_TYPE
        ),
    );
    if (!anchor.goal) {
      const firstRequest = withoutCards.findLast(
        (message) => message.role === "user",
      );
      if (firstRequest)
        anchor = createTaskAnchor(messageText(firstRequest), currentTurn);
    }
    const scoped = scopeMessagesToGoal(withoutCards, anchor.goal);
    const normalized = normalizeMessages(scoped);
    const keepRecentTurns = positiveInteger(
      pi.getFlag("context-card-recent-turns"),
      2,
    );
    const projection = projectContext(normalized, keepRecentTurns);
    const card = runtimeCard(ctx, normalized);
    lastCard = formatContextCard(card, {
      planProjectionMode: planProjectionMode(),
      planPhaseFramingMode: planPhaseFramingMode(),
    });
    const cardMessage: AgentMessage = {
      role: "custom",
      customType: CARD_MESSAGE_TYPE,
      content: lastCard,
      display: false,
      timestamp: Date.now(),
    };

    const branch = ctx.sessionManager.getBranch();
    let auditTurn = -1;
    let lastUserEntry = -1;
    branch.forEach((entry, index) => {
      if (entry.type === "message" && entry.message.role === "user") {
        auditTurn++;
        lastUserEntry = index;
      }
    });
    const request =
      branch
        .slice(lastUserEntry + 1)
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === AUDIT_ENTRY_TYPE,
        ).length + 1;
    const estimatedProjectedTokens = Math.ceil(
      (projection.projectedChars + lastCard.length) / 4,
    );
    const contextWindow = ctx.model?.contextWindow;
    lastAudit = {
      turn: auditTurn >= 0 ? auditTurn : Math.max(0, currentTurn - 1),
      request,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      contextWindow,
      estimatedProjectedTokens,
      projectedWindowPercent: contextWindow
        ? (estimatedProjectedTokens / contextWindow) * 100
        : undefined,
      cardChars: lastCard.length,
      originalMessages: scoped.length,
      projectedMessages: projection.messages.length,
      originalChars: projection.originalChars,
      projectedChars: projection.projectedChars,
      retiredMessages: projection.retiredMessages,
      retiredTurns: projection.retiredTurns,
      retired: projection.retired,
      hotEvidence: projection.hotEvidence,
      continuity: {
        taskId,
        planRevision: plan?.revision,
        planProjectionMode: planProjectionMode(),
        planProjectionState: planProjectionState(card, {
          planProjectionMode: planProjectionMode(),
        }),
        planPhaseFramingMode: planPhaseFramingMode(),
        planPhaseFramingState: planPhaseFramingState(card, {
          planPhaseFramingMode: planPhaseFramingMode(),
        }),
        planChars: plan?.content.length ?? 0,
        resumedChanges: card.resumed?.execution.changes.length ?? 0,
        resumedFailures: card.resumed?.execution.failures.length ?? 0,
        repositoryChanged: card.resumed?.repositoryChanged ?? false,
      },
    };
    if (pi.getFlag("context-card-audit") !== "off")
      pi.appendEntry<ProjectionAudit>(AUDIT_ENTRY_TYPE, lastAudit);
    ctx.ui.setStatus(
      "agent-context-card",
      `${projection.retiredMessages} message(s) retired · ${projection.messages.length} live`,
    );
    return { messages: [cardMessage, ...projection.messages] };
  });

  pi.registerCommand("card", {
    description: "Show the current agent context card",
    handler: async (_args, ctx) => {
      const normalized = normalizeMessages(
        branchMessages(ctx.sessionManager.getBranch()),
      );
      lastCard = formatContextCard(runtimeCard(ctx, normalized), {
        planProjectionMode: planProjectionMode(),
        planPhaseFramingMode: planPhaseFramingMode(),
      });
      ctx.ui.notify(lastCard, "info");
    },
  });
  pi.registerCommand("card-new", {
    description: "Start a new context card with an explicit goal",
    handler: async (args, ctx) => {
      if (!persistAnchor(args, true))
        return ctx.ui.notify("Usage: /card-new <goal>", "warning");
      latestRequest = anchor.goal;
      ctx.ui.notify(`Started new task: ${anchor.goal}`, "info");
    },
  });
  pi.registerCommand("card-reset", {
    description: "Clear the active context card",
    handler: async (_args, ctx) => {
      const closingTask = taskId;
      if (closingTask)
        taskAudit(
          "close",
          "info",
          `kept snapshot for taskId=${closingTask}; sessionId=${sessionIdOf(ctx) ?? "unknown"}`,
        );
      anchor = emptyAnchor();
      latestRequest = "";
      taskId = undefined;
      plan = undefined;
      planCandidate = undefined;
      resumedExecution = emptyExecutionJournal();
      resumedProvenance = undefined;
      pi.appendEntry<TaskAnchorDetails>(ANCHOR_ENTRY_TYPE, {
        anchor,
        reset: true,
      });
      persistPlanState();
      ctx.ui.notify("Context card reset. Stored snapshot kept.", "info");
    },
  });
  pi.registerCommand("card-stats", {
    description: "Show the latest context projection metrics",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        lastAudit
          ? `${lastAudit.retiredMessages} message(s) retired; ~${lastAudit.estimatedProjectedTokens} projected tokens (${lastAudit.projectedWindowPercent?.toFixed(2) ?? "?"}% of window).`
          : "No projection has run yet.",
        "info",
      );
    },
  });
}
