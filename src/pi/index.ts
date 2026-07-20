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
import { formatContextCard } from "../core/format";
import { projectContext } from "../core/projection";
import { buildRuntimeCard } from "../core/runtime";
import {
  ANCHOR_ENTRY_TYPE,
  AUDIT_ENTRY_TYPE,
  CARD_MESSAGE_TYPE,
  emptyAnchor,
  type ProjectionAudit,
  type TaskAnchor,
  type TaskAnchorDetails,
} from "../core/types";
import {
  messageText,
  normalizeMessages,
  scopeMessagesToGoal,
} from "./normalize";

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

  const reconstruct = (ctx: ExtensionContext): void => {
    anchor = emptyAnchor();
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== ANCHOR_ENTRY_TYPE)
        continue;
      const details = entry.data as TaskAnchorDetails | undefined;
      if (details?.anchor) anchor = details.anchor;
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

  const persistAnchor = (text: string, reset: boolean): boolean => {
    const next = createTaskAnchor(text, currentTurn);
    if (!next.goal) return false;
    anchor = next;
    pi.appendEntry<TaskAnchorDetails>(ANCHOR_ENTRY_TYPE, { anchor, reset });
    return true;
  };

  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
  pi.on("input", (event) => {
    const boundary = taskBoundaryForInput(event.text, {
      goal: anchor.goal,
      latestRequest,
      settled: previousTurnSettled,
    });
    if (!anchor.goal || boundary === "new") persistAnchor(event.text, true);
    latestRequest = taskGoalFromInput(event.text);
    previousTurnSettled = false;
  });
  pi.on("turn_end", (event) => {
    previousTurnSettled =
      event.message.role === "assistant" && event.message.stopReason === "stop";
    if (previousTurnSettled) currentTurn++;
  });

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
    lastCard = formatContextCard(
      buildRuntimeCard(ctx.cwd, anchor.goal, normalized),
    );
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
      lastCard = formatContextCard(
        buildRuntimeCard(ctx.cwd, anchor.goal, normalized),
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
      ctx.ui.notify(`Started new task: ${anchor.goal}`, "info");
    },
  });
  pi.registerCommand("card-reset", {
    description: "Clear the active context card",
    handler: async (_args, ctx) => {
      anchor = emptyAnchor();
      latestRequest = "";
      pi.appendEntry<TaskAnchorDetails>(ANCHOR_ENTRY_TYPE, {
        anchor,
        reset: true,
      });
      ctx.ui.notify("Context card reset.", "info");
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
