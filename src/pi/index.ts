import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTaskAnchor, taskGoalFromInput } from "../core/anchor";
import {
  extractPhaseLimitedDirectives,
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
import { checkCardInvariants } from "../core/invariants";
import { projectContext } from "../core/projection";
import { buildRuntimeCard } from "../core/runtime";
import {
  ANCHOR_ENTRY_TYPE,
  AUDIT_ENTRY_TYPE,
  CARD_MESSAGE_TYPE,
  CARD_NUDGE_MESSAGE_TYPE,
  CARD_STATE_ENTRY_TYPE,
  emptyAnchor,
  emptyCardState,
  emptyExecutionJournal,
  PLAN_ENTRY_TYPE,
  RESUME_ENTRY_TYPE,
  TASK_STATE_AUDIT_ENTRY_TYPE,
  type CardState,
  type CardStateDetails,
  type EvidenceLease,
  type ExecutionJournal,
  type PinnedPlan,
  type PlanCandidate,
  type PlanPhaseFramingMode,
  type PlanProjectionMode,
  type PlanStateDetails,
  type ProjectionAudit,
  type RepositoryIdentity,
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
import {
  repositoryIdentity,
  repositoryProvenance,
  SessionCardStore,
} from "./session-card-store";
import { tryForceUpdateCardToolCall } from "./before_provider_request";

const CARD_ACTIVITY_NUDGE_THRESHOLD = 10;
const CARD_NUDGE_STREAK_CAP = 2;

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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let latestRequest = "";
  let previousTurnSettled = false;
  let lastCard = "";
  let lastAudit: ProjectionAudit | undefined;
  let taskId: string | undefined;
  let plan: PinnedPlan | undefined;
  let planCandidate: PlanCandidate | undefined;
  let resumedExecution: ExecutionJournal = emptyExecutionJournal();
  let resumedProvenance: RepositoryProvenance | undefined;
  let planningTurn = false;
  let turnMutated = false;
  let cardState: CardState = emptyCardState();
  let cardActivitySinceUpdate = 0;
  let cardNudgeStreak = 0;
  let forceNudgeStreak = 0;
  // Global by default; overridable so tests never touch the real user
  // profile directory.
  const sessionStore = new SessionCardStore(
    process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR,
  );

  const sessionIdOf = (ctx: ExtensionContext): string | undefined => {
    const sessionManager = ctx.sessionManager as
      { getSessionId?: () => string } | undefined;
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

  const persistCardState = (): void => {
    pi.appendEntry<CardStateDetails>(CARD_STATE_ENTRY_TYPE, {
      state: cardState,
    });
  };

  const resetCardState = (): void => {
    cardState = emptyCardState();
    cardActivitySinceUpdate = 0;
    cardNudgeStreak = 0;
    forceNudgeStreak = 0;
  };

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
    cardState = emptyCardState();
    cardActivitySinceUpdate = 0;
    cardNudgeStreak = 0;
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
      if (entry.customType === CARD_STATE_ENTRY_TYPE) {
        const details = entry.data as CardStateDetails | undefined;
        if (details?.state) cardState = details.state;
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
  };

  const persistPlanState = (): void =>
    pi.appendEntry<PlanStateDetails>(PLAN_ENTRY_TYPE, {
      taskId,
      plan,
      candidate: planCandidate,
    });

  const saveSessionCard = async (ctx: ExtensionContext): Promise<void> => {
    if (!anchor.goal) return;
    const sessionId = sessionIdOf(ctx);
    if (!sessionId) return;
    const current = buildExecutionJournal(
      normalizeMessages(branchMessages(ctx.sessionManager.getBranch())),
    );
    const snapshot: TaskSnapshot = {
      schemaVersion: 1,
      sessionId,
      taskId,
      anchor,
      plan,
      candidate: planCandidate,
      execution: mergeExecutionJournals(resumedExecution, current),
      provenance: resumedProvenance
        ? repositoryProvenance(ctx.cwd)
        : { ...repositoryIdentity(ctx.cwd), worktree: "unused" },
      cardState: {
        pending: [...cardState.pending],
        findings: cardState.findings.map((finding) => ({
          topic: finding.topic,
          detail: finding.detail,
        })),
      },
      updatedAt: new Date().toISOString(),
    };
    try {
      await sessionStore.save(snapshot);
      taskAudit("save", "success");
    } catch (error) {
      taskAudit("save", "failed", String(error));
    }
  };

  const runtimeCard = (
    ctx: ExtensionContext,
    normalized: ReturnType<typeof normalizeMessages>,
    hotEvidence: EvidenceLease[] = [],
  ) => {
    const currentExecution = buildExecutionJournal(normalized);
    const priorExecution = unresolvedPriorExecution(
      resumedExecution,
      currentExecution,
    );
    const hasPriorExecution =
      priorExecution.changes.length > 0 || priorExecution.failures.length > 0;
    const repoIdentity: RepositoryIdentity = repositoryIdentity(ctx.cwd);
    const resumedProvenanceCheck = resumedProvenance
      ? { resumedProvenance, currentProvenance: repositoryProvenance(ctx.cwd) }
      : undefined;
    return buildRuntimeCard(
      ctx.cwd,
      anchor.goal,
      normalized,
      {
        taskId,
        plan,
        resumed:
          hasPriorExecution && resumedProvenanceCheck
            ? {
                execution: priorExecution,
                repositoryChanged: !sameRepositoryState(
                  resumedProvenanceCheck.resumedProvenance,
                  resumedProvenanceCheck.currentProvenance,
                ),
              }
            : undefined,
      },
      {
        pending: cardState.pending,
        findings: cardState.findings,
        filesRead: hotEvidence,
        repo: repoIdentity,
      },
    );
  };

  const persistAnchor = (text: string, reset: boolean): boolean => {
    const next = createTaskAnchor(text, currentTurn);
    if (!next.goal) return false;
    anchor = next;
    pi.appendEntry<TaskAnchorDetails>(ANCHOR_ENTRY_TYPE, { anchor, reset });
    return true;
  };

  const resumeFromSessionCard = async (
    ctx: ExtensionContext,
  ): Promise<void> => {
    if (anchor.goal) return;
    const sessionId = sessionIdOf(ctx);
    if (!sessionId) return;
    const loaded = await sessionStore.load(sessionId);
    if (loaded.status === "success") {
      const snapshot = loaded.snapshot;
      anchor = snapshot.anchor;
      taskId = snapshot.taskId;
      plan = snapshot.plan;
      planCandidate = snapshot.candidate;
      resumedExecution = snapshot.execution;
      resumedProvenance = snapshot.provenance;
      cardState = snapshot.cardState ?? emptyCardState();
      pi.appendEntry<ResumeStateDetails>(RESUME_ENTRY_TYPE, { snapshot });
      pi.appendEntry<TaskAnchorDetails>(ANCHOR_ENTRY_TYPE, {
        anchor,
        reset: true,
      });
      persistPlanState();
      persistCardState();
      taskAudit(
        "load",
        "success",
        `sessionId=${sessionId}; reason=session-restart`,
      );
    } else if (loaded.status === "corrupt") {
      taskAudit(
        "load",
        "corrupt",
        `sessionId=${sessionId}; detail=${loaded.detail}`,
      );
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    reconstruct(ctx);
    await resumeFromSessionCard(ctx);
    try {
      const removed = await sessionStore.collectGarbage();
      if (removed) taskAudit("gc", "success", `${removed} expired card(s)`);
    } catch (error) {
      taskAudit("gc", "failed", String(error));
    }
    const branch = ctx.sessionManager.getBranch();
    taskAudit(
      "session",
      "info",
      `sessionId=${sessionIdOf(ctx) ?? "unknown"}; branchEntries=${branch.length}; branchMessages=${branchMessages(branch).length}`,
    );
  });
  pi.on("session_tree", async (_event, ctx) => {
    reconstruct(ctx);
    const branch = ctx.sessionManager.getBranch();
    taskAudit(
      "session",
      "info",
      `tree sessionId=${sessionIdOf(ctx) ?? "unknown"}; branchEntries=${branch.length}; branchMessages=${branchMessages(branch).length}`,
    );
  });
  pi.on("input", async (event) => {
    const requestedId = taskIdFromInput(event.text);

    planningTurn = isPlanningRequest(event.text);
    turnMutated = false;
    if (planCandidate && !planningTurn) {
      plan = promotePlan(planCandidate, plan);
      planCandidate = undefined;
      persistPlanState();
    }

    if (!anchor.goal) {
      if (!taskId) {
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
    if (event.isError) return;
    const name = event.toolName.toLocaleLowerCase();
    if (
      name === "update_card" ||
      name === "card" ||
      name === "card_new" ||
      name === "card_reset"
    )
      return;
    if (name === "bash") {
      const args =
        event.result && typeof event.result === "object"
          ? (event.result as { args?: Record<string, unknown> })
          : undefined;
      const command =
        args?.args && typeof args.args.command === "string"
          ? args.args.command
          : "";
      const looksReadOnly =
        /\b(?:cat|less|more|head|tail|find|ls|grep|rg|wc|stat|file)\b/i.test(
          command,
        ) && !/&&|;|\|.*(?:>|tee)/i.test(command);
      const looksDiscovery = /(?:^|\s)(?:find|ls|grep|rg|tree)\b/i.test(
        command,
      );
      if (looksReadOnly || looksDiscovery) cardActivitySinceUpdate++;
      return;
    }
    if (
      [
        "read",
        "view_file",
        "find",
        "search",
        "grep",
        "glob",
        "list",
        "edit",
        "write",
        "apply_patch",
      ].includes(name)
    )
      cardActivitySinceUpdate++;
  });
  pi.on("turn_end", async (event, ctx) => {
    previousTurnSettled =
      event.message.role === "assistant" && event.message.stopReason === "stop";
    if (previousTurnSettled && planningTurn && !turnMutated) {
      const content = messageText(event.message).trim();
      if (content) {
        const { splitPlanContent } = await import("../core/continuity");
        const { body, scopeNotes } = splitPlanContent(content);
        planCandidate = {
          content: body,
          scopeNotes,
          sourceTurn: currentTurn,
          capturedAt: new Date().toISOString(),
        };
        persistPlanState();
      }
    }
    if (previousTurnSettled) {
      currentTurn++;
      await saveSessionCard(ctx);
      // Threshold of 10 meaningful read/search/write tool calls since the last
      // successful update_card balances silent context loss against nagging.
      if (
        cardActivitySinceUpdate > CARD_ACTIVITY_NUDGE_THRESHOLD &&
        anchor.goal &&
        cardNudgeStreak < CARD_NUDGE_STREAK_CAP
      ) {
        pi.sendMessage(
          {
            customType: CARD_NUDGE_MESSAGE_TYPE,
            content:
              "You have done meaningful work without updating the agent context card. Call update_card now (with any findings or pending items since the last update) or call it with the existing fields unchanged to confirm nothing new is worth recording. The card is the only memory that survives between turns.",
            display: false,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
        cardNudgeStreak++;
      } else if (
        cardActivitySinceUpdate > CARD_ACTIVITY_NUDGE_THRESHOLD &&
        cardNudgeStreak >= CARD_NUDGE_STREAK_CAP
      ) {
        taskAudit(
          "session",
          "skipped",
          `card update nudge cap reached (${CARD_NUDGE_STREAK_CAP}); activity=${cardActivitySinceUpdate}`,
        );
      }
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => saveSessionCard(ctx));

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
    let card = runtimeCard(ctx, normalized, projection.hotEvidence);
    const violations = checkCardInvariants(card);
    if (
      violations.some((v) => v.rule === "stale-plan-directive") &&
      card.plan
    ) {
      const { body } = extractPhaseLimitedDirectives(card.plan.content);
      card = {
        ...card,
        plan: { ...card.plan, content: body },
      };
    }
    lastCard = formatContextCard(card, {
      planProjectionMode: planProjectionMode(),
      planPhaseFramingMode: planPhaseFramingMode(),
    });
    const retiredNotes =
      card.plan?.scopeNotes &&
      planPhaseFramingState(card, {
        planPhaseFramingMode: planPhaseFramingMode(),
      }) === "post-planning"
        ? card.plan.scopeNotes
        : undefined;

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
      retiredProcessNotes: retiredNotes,
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
      pi.appendEntry<ProjectionAudit>(AUDIT_ENTRY_TYPE, {
        ...lastAudit,
        invariantViolations: violations.length > 0 ? violations : undefined,
      });
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
      const projection = projectContext(normalized, 2);
      lastCard = formatContextCard(
        runtimeCard(ctx, normalized, projection.hotEvidence),
        {
          planProjectionMode: planProjectionMode(),
          planPhaseFramingMode: planPhaseFramingMode(),
        },
      );
      ctx.ui.notify(lastCard, "info");
    },
  });
  pi.registerCommand("card-new", {
    description: "Start a new context card with an explicit goal",
    handler: async (args, ctx) => {
      if (!persistAnchor(args, true))
        return ctx.ui.notify("Usage: /card-new <goal>", "warning");
      latestRequest = anchor.goal;
      resetCardState();
      ctx.ui.notify(`Started new task: ${anchor.goal}`, "info");
    },
  });
  pi.registerCommand("card-reset", {
    description: "Clear the active context card",
    handler: async (_args, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (sessionId)
        taskAudit(
          "close",
          "info",
          `kept session card on disk; sessionId=${sessionId}`,
        );
      anchor = emptyAnchor();
      latestRequest = "";
      taskId = undefined;
      plan = undefined;
      planCandidate = undefined;
      resumedExecution = emptyExecutionJournal();
      resumedProvenance = undefined;
      resetCardState();
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

  pi.registerTool({
    name: "update_card",
    label: "Update agent context card",
    description:
      "This card is the only memory that survives between turns of this session - nothing else you write or read carries forward except what's in it. Update it when you learn, decide, or rule something out. Write only what your future self will actually need; omit what's obvious or already resolved. What you skip stating precisely, you lose. Each provided field fully replaces the current value; omit a field to leave it unchanged.",
    parameters: Type.Object({
      pending: Type.Optional(Type.Array(Type.String())),
      findings: Type.Optional(
        Type.Array(
          Type.Object({
            topic: Type.String(),
            detail: Type.String(),
          }),
        ),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        pending?: string[];
        findings?: { topic: string; detail: string }[];
      },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      if (Array.isArray(params.pending))
        cardState.pending = [...params.pending];
      if (Array.isArray(params.findings))
        cardState.findings = params.findings.map((finding) => ({
          topic: finding.topic,
          detail: finding.detail,
        }));
      persistCardState();
      cardActivitySinceUpdate = 0;
      cardNudgeStreak = 0;
      forceNudgeStreak = 0;
      return {
        content: [{ type: "text", text: "Card updated." }],
        details: {},
      };
    },
  });

  pi.on("before_provider_request", (event, _ctx) => {
    const payload = event.payload;
    if (payload === undefined || payload === null || typeof payload !== "object") {
      return undefined;
    }
    const payloadWithOrder = payload as Record<string, unknown>;
    const messages = payloadWithOrder.messages;
    const tools = payloadWithOrder.tools;
    if (!Array.isArray(messages)) {
      return undefined;
    }
    if (!Array.isArray(tools)) {
      return undefined;
    }
    const hasUpdateCard = tools.some(
      (tool): tool is { function: { name: string } } =>
        tool !== null &&
        typeof tool === "object" &&
        "function" in tool &&
        typeof tool.function === "object" &&
        tool.function.name === "update_card",
    );
    if (!hasUpdateCard) {
      return undefined;
    }
    if (payloadWithOrder.tool_choice !== undefined) {
      return undefined;
    }
    if (
      cardActivitySinceUpdate > CARD_ACTIVITY_NUDGE_THRESHOLD &&
      forceNudgeStreak < CARD_NUDGE_STREAK_CAP
    ) {
      const forcedPayload = tryForceUpdateCardToolCall(payload);
      if (forcedPayload !== undefined) {
        forceNudgeStreak++;
        taskAudit(
          "forcing",
          "info",
          `card update forced via tool_choice; activity=${cardActivitySinceUpdate}; streak=${forceNudgeStreak}`,
        );
        return forcedPayload;
      }
    }
    return undefined;
  });
};