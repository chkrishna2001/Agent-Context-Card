import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTaskAnchor, taskGoalFromInput } from "../core/anchor";
import { commandSignature } from "../core/command-signature";
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
  type Interval,
  isFullyCovered,
  mergeInterval,
} from "../core/intervals";
import {
  formatCardStatus,
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
  STATUS_MESSAGE_TYPE,
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
// A read this large is worth distilling before it's just left sitting in
// context - large enough that "a costly read just happened" is a real,
// pointed reason to ask now rather than waiting for the generic activity
// counter to catch up.
const COSTLY_READ_CHARS = 4000;
// Two consecutive failures of the exact same call is already unambiguous -
// a deterministic tool re-run against an unchanged repo can't succeed the
// second time just because it's asked again.
const REPEATED_FAILURE_NUDGE_THRESHOLD = 2;
// Same reasoning as the failure case, mirrored for successes: two identical
// successful calls in a row means the second one already told the agent
// everything the first one did. This is deliberately signature equality,
// not a classifier over what the command "looks like" (e.g. read-only vs.
// discovery vs. verification) - a regex over command text can't keep up
// with every language's test/run/verify invocation, but exact repetition
// of name+arguments is unambiguous regardless of what the tool does.
const REPEATED_SUCCESS_NUDGE_THRESHOLD = 2;
// Steering the model away from a repeat - soft nudge, then forced
// tool_choice - depends on the provider actually honoring what we send it.
// Traced evidence from a live run: before_provider_request forced
// tool_choice to update_card twice in the same turn, and the model called
// update_card zero times either time - the provider silently didn't comply,
// and the same call then repeated 143 times before the turn timed out.
// Steering can only ever be a request; this threshold is enforced in our
// own code at the tool_call stage, before execution, independent of
// anything the provider does with a forced tool_choice.
const HARD_BLOCK_REPEAT_THRESHOLD = 3;
// The hard block's own refusal text is not a steering channel - it's a
// tool-result the model reads as "that call failed," and evidence from two
// live sessions shows a model stuck in this loop just resubmits the exact
// same call in response, 8 and 20+ times respectively, forever, since
// nothing caps it. What broke the loop both times wasn't a stronger refusal;
// it was a genuine user-turn message asking what the model was trying to do,
// which forced it to articulate the goal and pick something else. Capped
// like the other nudge streaks so an unattended session doesn't manufacture
// user turns indefinitely if even that doesn't land.
const HARD_BLOCK_REFLECTION_STREAK_CAP = 2;

const READ_TOOL_NAMES = new Set(["read", "view_file"]);

// Line range a read-like call would return, as a half-open [start, end)
// interval, or undefined if this call isn't a path+offset/limit read we can
// reason about. Offset defaults to line 1 (matches observed 1-indexed
// argument values); a missing limit means "to end of file", modeled as a
// very large end so it only shows as covered by an equally-unbounded prior
// read, never falsely satisfied by a small bounded one.
function readRange(
  toolName: string,
  input: Record<string, unknown>,
): { path: string; range: Interval } | undefined {
  if (!READ_TOOL_NAMES.has(toolName.toLocaleLowerCase())) return undefined;
  const path = typeof input.path === "string" ? input.path : undefined;
  if (!path) return undefined;
  const offset =
    typeof input.offset === "number" && Number.isFinite(input.offset)
      ? input.offset
      : 1;
  const limit =
    typeof input.limit === "number" &&
    Number.isFinite(input.limit) &&
    input.limit > 0
      ? input.limit
      : Number.MAX_SAFE_INTEGER - offset;
  return { path, range: [offset, offset + limit] };
}

const BASH_TOOL_NAMES = new Set(["bash", "shell", "execute_bash"]);

// Normalized `${verb}:${pattern}` key for a bash call this project knows how
// to fuzzy-match, or undefined if it isn't a search-style command
// `commandSignature` recognizes (see src/core/command-signature.ts for the
// allow-list and why it's kept narrow).
function bashPatternKey(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!BASH_TOOL_NAMES.has(toolName.toLocaleLowerCase())) return undefined;
  const command = typeof input.command === "string" ? input.command : "";
  const parsed = commandSignature(command);
  return parsed ? `${parsed.verb}:${parsed.pattern}` : undefined;
}

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
  let lastStatus = "";
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
  // True from the moment a forced update_card tool_choice is issued until
  // that call actually lands, so the tool's own handler can tell a real
  // response from a no-op one - forcing only compels the call, not its
  // content, so a thin response shouldn't reset the streaks as if it had
  // resolved anything.
  let awaitingForcedSubstance = false;
  // Signature (tool name + arguments) of the most recent tool call args
  // seen at tool_execution_start, keyed by call id so tool_execution_end -
  // which carries no args of its own - can look up what actually ran.
  const pendingCallSignatures = new Map<string, string>();
  // Mirrors pendingCallSignatures's lifecycle (set at tool_execution_start,
  // consumed and deleted at tool_execution_end) but carries the parsed
  // path+range instead of a stringified signature, since tool_execution_end
  // has no args of its own to recompute it from.
  const pendingReadRanges = new Map<
    string,
    { path: string; range: Interval } | undefined
  >();
  // Cache of the last successful result for each unique tool call signature.
  // This allows us to break "block loops" by providing the cached result
  // instead of refusing the call when it repeats.
  const successfulCallCache = new Map<string, any>();
  // Tracks a call that just failed with the exact same signature as the
  // one immediately before it - a model stuck repeating a broken command
  // verbatim rather than adjusting. Resets on any success or on a
  // differently-signatured failure, so it only fires on genuine
  // back-to-back repetition, never accumulated tolerance across a session.
  let lastFailedCallSignature: string | undefined;
  let repeatedFailureCount = 0;
  let repeatedFailureNudgeStreak = 0;
  // Same tracking, mirrored for a call that keeps succeeding with the exact
  // same signature - the model-agnostic, tool-agnostic version of "you're
  // repeating yourself" that a duplicate-round projection collapse can hide
  // from the model (each request looks the same as the last, so nothing in
  // its own view of the world signals it should stop).
  let lastSuccessfulCallSignature: string | undefined;
  let repeatedSuccessCount = 0;
  let repeatedSuccessNudgeStreak = 0;
  // Set when a repeated-success escalation is what pushed activity past the
  // forcing threshold, so the forced call's resolution handler knows this
  // wasn't ordinary accumulated work - "resume exactly what you were doing"
  // would be actively wrong here, since what it was doing is the repeated
  // call itself. Cleared the moment a forced call resolves, whatever caused
  // it, so a later unrelated force never inherits a stale reason.
  let forcedDueToRepeatedSuccess = false;
  // Tracked independently of the tool_execution_end-based counters above -
  // this fires at the tool_call stage, before the call has even run, so it
  // has no notion of success/failure yet and doesn't need one: the same
  // exact signature arriving a third consecutive time is blocked outright,
  // regardless of whether it succeeded or failed the first two times.
  let lastAttemptedCallSignature: string | undefined;
  let consecutiveAttemptCount = 0;
  // How many times we've escalated the hard-block refusal for the *current*
  // stuck signature with a real user-turn message rather than just the
  // tool-result refusal text. Resets whenever the attempted signature
  // changes, mirroring consecutiveAttemptCount.
  let hardBlockReflectionStreak = 0;
  // Union of line ranges successfully read from each path so far, keyed by
  // path. Traced evidence from a live run: a model oscillating between
  // overlapping windows of the same 996-line file made 27 reads, no two
  // with the same offset/limit, so consecutiveAttemptCount above never saw
  // a repeated signature and the hard block never engaged even once. A read
  // whose entire requested range is already inside this union is redundant
  // regardless of its exact arguments.
  const readCoverage = new Map<string, Interval[]>();
  // Consecutive redundant-by-containment read count per path. Deliberately
  // separate from consecutiveAttemptCount: containment isn't about the
  // immediately preceding call being identical, it's about this path's
  // cumulative known content already including everything the new call
  // would return, so an interleaved read of a *different* path must not
  // reset it - only a read of this same path that actually extends its
  // coverage should.
  const containedRepeatCounts = new Map<string, number>();
  // Mirrors hardBlockReflectionStreak, but per path for the same reason
  // containedRepeatCounts is per path rather than global.
  const containedReflectionStreaks = new Map<string, number>();
  // Consecutive count of bash calls that normalize to the same
  // `${verb}:${pattern}` key (see bashPatternKey), keyed per that
  // normalized key rather than globally - the same reasoning as
  // containedRepeatCounts: an interleaved bash call under a different key
  // must not reset this key's count, and two genuinely different search
  // patterns sharing a verb get independent keys and never interact.
  // Deliberately not merged with the exact-signature counters above: a
  // command's output isn't provably safe to treat as redundant just because
  // its pattern repeats (unlike a read's content), so this only ever feeds
  // the block-and-reflect path, never the success cache.
  const bashPatternCounts = new Map<string, number>();
  // Mirrors containedReflectionStreaks, same per-key reasoning.
  const bashPatternReflectionStreaks = new Map<string, number>();
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
    awaitingForcedSubstance = false;
    lastFailedCallSignature = undefined;
    repeatedFailureCount = 0;
    repeatedFailureNudgeStreak = 0;
    lastSuccessfulCallSignature = undefined;
    repeatedSuccessCount = 0;
    repeatedSuccessNudgeStreak = 0;
    forcedDueToRepeatedSuccess = false;
    lastAttemptedCallSignature = undefined;
    consecutiveAttemptCount = 0;
    hardBlockReflectionStreak = 0;
    readCoverage.clear();
    containedRepeatCounts.clear();
    containedReflectionStreaks.clear();
    bashPatternCounts.clear();
    bashPatternReflectionStreaks.clear();
    successfulCallCache.clear();
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
    forceNudgeStreak = 0;
    awaitingForcedSubstance = false;
    pendingCallSignatures.clear();
    pendingReadRanges.clear();
    lastFailedCallSignature = undefined;
    repeatedFailureCount = 0;
    repeatedFailureNudgeStreak = 0;
    lastSuccessfulCallSignature = undefined;
    repeatedSuccessCount = 0;
    repeatedSuccessNudgeStreak = 0;
    forcedDueToRepeatedSuccess = false;
    lastAttemptedCallSignature = undefined;
    consecutiveAttemptCount = 0;
    hardBlockReflectionStreak = 0;
    readCoverage.clear();
    containedRepeatCounts.clear();
    containedReflectionStreaks.clear();
    bashPatternCounts.clear();
    bashPatternReflectionStreaks.clear();
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== ANCHOR_ENTRY_TYPE)
        continue;
      const details = entry.data as TaskAnchorDetails | undefined;
      if (details?.anchor) anchor = details.anchor;
      if (details?.taskId !== undefined) taskId = details.taskId;
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
    pi.appendEntry<TaskAnchorDetails>(ANCHOR_ENTRY_TYPE, {
      anchor,
      reset,
      taskId,
    });
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
        taskId,
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
  pi.on("before_agent_start", (event, ctx) => {
    // hasUI is false exactly when no dialog-capable UI exists for anyone to
    // answer through (print/json/headless runs) - true in tui and rpc modes,
    // where a real person genuinely might be on the other end. Only in the
    // former case is "there is no user" actually a fact rather than a
    // guess, so only append there - telling an interactive session there's
    // no one to ask would be wrong, not just unnecessary.
    taskAudit(
      "session",
      "info",
      `before_agent_start fired; ctx.hasUI=${ctx.hasUI}; ctx.mode=${ctx.mode}`,
    );
    if (ctx.hasUI) return undefined;
    // "Act, don't just describe" is the right push for an implementation
    // turn, but it directly contradicts a planning turn's own instruction to
    // produce a plan and not touch files - a model caught between the two
    // has nothing but investigation tools left to call, and no clear signal
    // that concluding with a plain text plan (its only remaining valid
    // action) counts as "acting" rather than "only describing it in text".
    // That contradiction was observed driving exactly this: a plan turn that
    // fully identified the correct fix across several update_card findings,
    // then kept re-running the same verification check dozens of times
    // instead of ever concluding.
    const actionGuidance = planningTurn
      ? "This turn asks only for a plan - concluding with a text-only plan once your investigation is complete is the correct final action here, not a case of 'only describing it in text' or 'asking whether to proceed'. Do not call a file-modifying tool in this turn."
      : "Once you've identified a fix, make it directly with the appropriate tool call rather than only describing it in text or asking whether to proceed.";
    return {
      systemPrompt: `${event.systemPrompt}\n\nThis session is running unattended: no user is available to answer questions or confirm actions before you take them. ${actionGuidance}`,
    };
  });
  pi.on("tool_call", (event) => {
    const name = event.toolName.toLocaleLowerCase();
    if (
      name === "update_card" ||
      name === "card" ||
      name === "card_new" ||
      name === "card_reset"
    )
      return undefined;
    const signature = `${event.toolName}:${JSON.stringify(event.input)}`;
    const isRepeatAttempt = signature === lastAttemptedCallSignature;
    consecutiveAttemptCount = isRepeatAttempt ? consecutiveAttemptCount + 1 : 1;
    lastAttemptedCallSignature = signature;
    if (!isRepeatAttempt) hardBlockReflectionStreak = 0;

    // Intercept repeated calls: if we have a cached successful result for this
    // exact signature, return it immediately instead of blocking or executing
    // - but only below the hard-block threshold. Traced evidence from a live
    // run: once a signature had succeeded once, every future identical
    // repeat was being served from cache unconditionally, with no cap at
    // all - the model got a normal-looking success every time, never an
    // error or refusal, so it had no signal anything was wrong and looped
    // the same bash command 446 times across a full 20-minute turn timeout.
    // Below the threshold, caching still avoids a real re-execution for a
    // handful of legitimate quick repeats; at or past it, this must fall
    // through to the same block-and-reflect path as any other stuck exact
    // repeat, not bypass it entirely.
    if (consecutiveAttemptCount < HARD_BLOCK_REPEAT_THRESHOLD) {
      const cachedResult = successfulCallCache.get(signature);
      if (cachedResult !== undefined) {
        taskAudit(
          "cache",
          "hit",
          `returning cached result for repeated call: ${signature}`,
        );
        return {
          result: cachedResult,
        };
      }
    }

    const read = readRange(event.toolName, event.input);
    if (read) {
      const covered = readCoverage.get(read.path) ?? [];
      if (covered.length > 0 && isFullyCovered(covered, read.range)) {
        const nextCount = (containedRepeatCounts.get(read.path) ?? 0) + 1;
        containedRepeatCounts.set(read.path, nextCount);
        if (nextCount >= HARD_BLOCK_REPEAT_THRESHOLD) {
          taskAudit(
            "forcing",
            "info",
            `blocked contained-range repeat read at tool_call stage; path=${read.path}; count=${nextCount}`,
          );
          const streak = containedReflectionStreaks.get(read.path) ?? 0;
          if (streak < HARD_BLOCK_REFLECTION_STREAK_CAP) {
            containedReflectionStreaks.set(read.path, streak + 1);
            pi.sendUserMessage(
              `You just requested ${read.path} again, and every line of what you asked for is already something you read earlier in this conversation - look back at your own prior reads of this file instead of requesting it again. Stop and answer this first, in plain text: what specific information are you still missing from this file, and where in it do you expect to find that you haven't already looked? Once you've answered that, either request a genuinely different range of this file, or move on to a different action.`,
              { deliverAs: "steer" },
            );
          }
          return {
            block: true,
            reason:
              "Every line this call requested has already been returned by an earlier read of the same path in this conversation, under different offset/limit arguments - it is refused as redundant rather than executed again. Look back at the earlier read(s) of this file instead of retrying. If you need content this file doesn't have, take a genuinely different action.",
          };
        }
      } else {
        containedRepeatCounts.set(read.path, 0);
      }
    }

    // Only calls whose full signature differs from the immediately
    // preceding attempt are counted here - a byte-identical repeat is
    // already the exact-signature hard block's job below, whose message
    // ("the exact same arguments again") is accurate for that case; this
    // mechanism exists specifically for the case that check misses, where
    // the pattern repeats but the surrounding arguments genuinely vary.
    const patternKey = isRepeatAttempt
      ? undefined
      : bashPatternKey(event.toolName, event.input);
    if (patternKey) {
      const nextCount = (bashPatternCounts.get(patternKey) ?? 0) + 1;
      bashPatternCounts.set(patternKey, nextCount);
      if (nextCount >= HARD_BLOCK_REPEAT_THRESHOLD) {
        taskAudit(
          "forcing",
          "info",
          `blocked near-duplicate search command at tool_call stage; pattern=${patternKey}; count=${nextCount}`,
        );
        const streak = bashPatternReflectionStreaks.get(patternKey) ?? 0;
        if (streak < HARD_BLOCK_REFLECTION_STREAK_CAP) {
          bashPatternReflectionStreaks.set(patternKey, streak + 1);
          pi.sendUserMessage(
            `You've now run a search with the same pattern (${patternKey}) several times in a row, only varying the surrounding arguments (e.g. which files it's scoped to) - that's not a new search, it's the same one repeated. Stop and answer this first, in plain text: what did the earlier run(s) of this search already tell you, and what specifically are you still trying to find that a broader or narrower search of the same pattern would answer? Once you've answered that, either act on what you already found, or search for something genuinely different.`,
            { deliverAs: "steer" },
          );
        }
        return {
          block: true,
          reason:
            "This search pattern has been run several times in a row with only the surrounding arguments (e.g. target files) varying - it is refused as a near-duplicate rather than executed again. Use the results you already have instead of re-running the same search.",
        };
      }
    }

    if (consecutiveAttemptCount < HARD_BLOCK_REPEAT_THRESHOLD) return undefined;
    taskAudit(
      "forcing",
      "info",
      `blocked repeated call at tool_call stage; count=${consecutiveAttemptCount}`,
    );
    if (hardBlockReflectionStreak < HARD_BLOCK_REFLECTION_STREAK_CAP) {
      hardBlockReflectionStreak++;
      pi.sendUserMessage(
        `You just tried to call ${event.toolName} with the exact same arguments again, and it's being refused every time. Stop and answer this first, in plain text: what are you actually trying to achieve right now, and why did you expect repeating that exact call to get you there? Once you've answered that, either call update_card if it's already satisfied, or take a genuinely different action toward it - not this call again.`,
        { deliverAs: "steer" },
      );
    }
    return {
      block: true,
      reason:
        "This exact call has already been made in a row with no new arguments and is being blocked - steering the model away from it did not work, so it is refused outright rather than executed again. Do not retry it verbatim. Check it against your pending list: if it already satisfies a pending item, call update_card to drop or complete that item; otherwise take a genuinely different action.",
    };
  });
  pi.on("tool_execution_start", (event) => {
    pendingCallSignatures.set(
      event.toolCallId,
      `${event.toolName}:${JSON.stringify(event.args)}`,
    );
    pendingReadRanges.set(
      event.toolCallId,
      readRange(event.toolName, event.args ?? {}),
    );
  });
  pi.on("tool_execution_end", (event) => {
    const signature = pendingCallSignatures.get(event.toolCallId);
    pendingCallSignatures.delete(event.toolCallId);
    const pendingRead = pendingReadRanges.get(event.toolCallId);
    pendingReadRanges.delete(event.toolCallId);
    if (pendingRead && !event.isError) {
      const priorCoverage = readCoverage.get(pendingRead.path) ?? [];
      // Only a read that actually extends this path's known coverage is
      // real progress. A contained repeat that executed anyway (its streak
      // was still below the block threshold) must not reset the streak
      // that's specifically counting contained repeats - resetting it here
      // would let the count restart every round and never reach the
      // threshold at all.
      if (!isFullyCovered(priorCoverage, pendingRead.range)) {
        containedRepeatCounts.set(pendingRead.path, 0);
        containedReflectionStreaks.set(pendingRead.path, 0);
      }
      readCoverage.set(
        pendingRead.path,
        mergeInterval(priorCoverage, pendingRead.range),
      );
    }
    if (signature !== undefined && event.isError) {
      // A failure breaks any in-progress identical-success streak just as
      // surely as a differently-signatured success would - the next success,
      // even with the same signature as before the failure, is a fresh
      // recovery, not a continuation of the earlier streak.
      lastSuccessfulCallSignature = undefined;
      repeatedSuccessCount = 0;
      repeatedSuccessNudgeStreak = 0;
      repeatedFailureCount =
        signature === lastFailedCallSignature ? repeatedFailureCount + 1 : 1;
      lastFailedCallSignature = signature;
      if (repeatedFailureCount === 1) repeatedFailureNudgeStreak = 0;
      if (
        repeatedFailureCount >= REPEATED_FAILURE_NUDGE_THRESHOLD &&
        repeatedFailureNudgeStreak < CARD_NUDGE_STREAK_CAP
      ) {
        pi.sendMessage(
          {
            customType: CARD_NUDGE_MESSAGE_TYPE,
            content:
              "That exact tool call just failed the same way it did immediately before - repeating it again won't produce a different result. Check the assumption behind it (file path, command syntax, argument) and try something different rather than retrying verbatim.",
            display: false,
          },
          { deliverAs: "steer" },
        );
        repeatedFailureNudgeStreak++;
      }
    } else if (signature !== undefined) {
      // Cache the successful result for future repeats of this exact signature.
      successfulCallCache.set(signature, event.result);

      lastFailedCallSignature = undefined;
      repeatedFailureCount = 0;
      repeatedFailureNudgeStreak = 0;
      repeatedSuccessCount =
        signature === lastSuccessfulCallSignature
          ? repeatedSuccessCount + 1
          : 1;
      lastSuccessfulCallSignature = signature;
      if (repeatedSuccessCount === 1) repeatedSuccessNudgeStreak = 0;
      if (
        repeatedSuccessCount >= REPEATED_SUCCESS_NUDGE_THRESHOLD &&
        repeatedSuccessNudgeStreak < CARD_NUDGE_STREAK_CAP
      ) {
        pi.sendMessage(
          {
            customType: CARD_NUDGE_MESSAGE_TYPE,
            content:
              "That exact call just succeeded with the same result as the call immediately before it - running it again won't tell you anything new. That repetition is now recorded in 'what happened' above; if it satisfies something on your pending list, call update_card to drop or complete that item instead of checking again.",
            display: false,
          },
          { deliverAs: "steer" },
        );
        repeatedSuccessNudgeStreak++;
        // Escalate straight past the generic activity threshold, the same
        // way a costly read does below - a soft steer alone may not land
        // once a model is already producing tool-call-only responses with
        // no reasoning text to redirect, so give the before_provider_request
        // forcing mechanism a chance to engage on the very next request too.
        cardActivitySinceUpdate = Math.max(
          cardActivitySinceUpdate,
          CARD_ACTIVITY_NUDGE_THRESHOLD + 1,
        );
        forcedDueToRepeatedSuccess = true;
      }
    }
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
    ) {
      cardActivitySinceUpdate++;
      if (["read", "view_file"].includes(name)) {
        const resultText = event.result
          ? messageText(event.result as AgentMessage)
          : "";
        if (resultText.length > COSTLY_READ_CHARS) {
          // A big read is worth distilling before anything else happens -
          // push straight past the generic activity threshold instead of
          // waiting for it to accumulate on its own, so the nudge/force
          // machinery below engages on the very next opportunity.
          cardActivitySinceUpdate = Math.max(
            cardActivitySinceUpdate,
            CARD_ACTIVITY_NUDGE_THRESHOLD + 1,
          );
        }
      }
    }
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
          message.role === "custom" &&
          (message.customType === CARD_MESSAGE_TYPE ||
            message.customType === STATUS_MESSAGE_TYPE)
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
    lastStatus = formatCardStatus(card);
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
    // Kept out of cardMessage (position 0) so its near-every-round churn
    // (findings, pending, file-read leases, failures) doesn't invalidate
    // the provider's prefix cache for the stable conversation history that
    // sits between the two messages.
    const statusMessage: AgentMessage | undefined = lastStatus
      ? {
          role: "custom",
          customType: STATUS_MESSAGE_TYPE,
          content: lastStatus,
          display: false,
          timestamp: Date.now(),
        }
      : undefined;

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
      (projection.projectedChars + lastCard.length + lastStatus.length) / 4,
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
      statusChars: lastStatus.length,
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
    return {
      messages: statusMessage
        ? [cardMessage, ...projection.messages, statusMessage]
        : [cardMessage, ...projection.messages],
    };
  });

  pi.registerCommand("card", {
    description: "Show the current agent context card",
    handler: async (_args, ctx) => {
      const normalized = normalizeMessages(
        branchMessages(ctx.sessionManager.getBranch()),
      );
      const projection = projectContext(normalized, 2);
      const card = runtimeCard(ctx, normalized, projection.hotEvidence);
      lastCard = formatContextCard(card, {
        planProjectionMode: planProjectionMode(),
        planPhaseFramingMode: planPhaseFramingMode(),
      });
      lastStatus = formatCardStatus(card);
      ctx.ui.notify(
        lastStatus ? `${lastCard}\n${lastStatus}` : lastCard,
        "info",
      );
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
        taskId,
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
            sources: Type.Optional(
              Type.Array(Type.String(), {
                description:
                  "File paths this finding distills. Citing a path here lets its raw read retire from context once this finding has been recorded, instead of both staying in context.",
              }),
            ),
          }),
        ),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        pending?: string[];
        findings?: { topic: string; detail: string; sources?: string[] }[];
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
          sources: finding.sources,
        }));
      persistCardState();

      const hasSubstance =
        (Array.isArray(params.pending) &&
          params.pending.some((item) => item.trim())) ||
        (Array.isArray(params.findings) &&
          params.findings.some((finding) => finding.detail?.trim()));
      const wasForced = awaitingForcedSubstance;
      awaitingForcedSubstance = false;

      if (wasForced && !hasSubstance) {
        // Forcing compels the call, not its content - a thin response to a
        // forced request hasn't actually resolved anything, so the streaks
        // (and the force itself) stay live for the next request instead of
        // being cleared as if it had.
        taskAudit(
          "forcing",
          "skipped",
          `forced update_card returned no findings/pending; streak=${forceNudgeStreak}`,
        );
      } else {
        cardActivitySinceUpdate = 0;
        cardNudgeStreak = 0;
        forceNudgeStreak = 0;
      }
      if (wasForced) {
        const dueToRepetition = forcedDueToRepeatedSuccess;
        forcedDueToRepeatedSuccess = false;
        if (dueToRepetition) {
          // This force fired because a call kept succeeding with an
          // unchanged result, not because of ordinary accumulated work - the
          // generic "resume exactly what you were doing before it" message
          // below would tell the model to resume the very repetition this
          // was meant to interrupt. Point it at something different instead:
          // reconcile pending against what's already been confirmed, or do
          // something that isn't the call that just triggered this.
          pi.sendMessage(
            {
              customType: CARD_NUDGE_MESSAGE_TYPE,
              content:
                "That update_card call was compelled because the same call kept succeeding with the same result - do not repeat that call again. Check it against your pending list: if it already satisfies a pending item, drop or complete that item. Otherwise take a genuinely different action toward the goal.",
              display: false,
            },
            { deliverAs: "steer" },
          );
        } else {
          // tool_choice forcing pins the model's entire response to this one
          // call, which cuts off whatever it was mid-way through doing. Left
          // alone, the next generation reliably treated that interruption as
          // a wrap-up cue - writing its plan out in prose and stopping,
          // exactly where it would otherwise have moved to edit/write calls
          // (confirmed against a live trace: a full, correct patch plan
          // narrated in text, then stopReason "stop", never an edit). Steer
          // it back to acting in the same breath the forced call resolves,
          // before the model gets a free-choice turn to decide it's done.
          pi.sendMessage(
            {
              customType: CARD_NUDGE_MESSAGE_TYPE,
              content:
                "That update_card call was compelled by the harness, not a natural stopping point - it does not mean the task is done. Resume exactly what you were doing before it. If you now have a concrete fix in mind, make it with an edit/apply_patch/write call instead of only describing it in text.",
              display: false,
            },
            { deliverAs: "steer" },
          );
        }
      }
      return {
        content: [{ type: "text", text: "Card updated." }],
        details: {},
      };
    },
  });

  pi.on("before_provider_request", (event, _ctx) => {
    const payload = event.payload;
    if (
      payload === undefined ||
      payload === null ||
      typeof payload !== "object"
    ) {
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
        awaitingForcedSubstance = true;
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
}
