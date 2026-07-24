import { createHash } from "node:crypto";
import type {
  ContextMessage,
  EvidenceLease,
  ProjectionResult,
  RetirementCounts,
  ToolCall,
} from "./types";

interface Round<TRaw> {
  index: number;
  message: ContextMessage<TRaw>;
  calls: ToolCall[];
}

function command(call: ToolCall): string {
  return typeof call.arguments.command === "string"
    ? call.arguments.command
    : "";
}

function isDiscovery(call: ToolCall): boolean {
  if (["find", "search", "grep", "glob", "list"].includes(call.name))
    return true;
  return (
    ["bash", "shell", "shell_command"].includes(call.name) &&
    /(?:^|[;&|]\s*)(?:find|ls|dir|tree|rg|grep|Get-ChildItem|Select-String)\b/i.test(
      command(call),
    )
  );
}

function isListing(call: ToolCall): boolean {
  if (["find", "glob", "list"].includes(call.name)) return true;
  return (
    ["bash", "shell", "shell_command"].includes(call.name) &&
    /(?:^|[;&|]\s*)(?:find|ls|dir|tree|Get-ChildItem)\b/i.test(command(call))
  );
}

function isRead(call: ToolCall): boolean {
  return ["read", "view_file"].includes(call.name);
}

function isMutation(call: ToolCall): boolean {
  return [
    "edit",
    "write",
    "apply_patch",
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
  ].includes(call.name);
}

function filePath(args: Record<string, unknown>): string | undefined {
  for (const key of [
    "path",
    "file_path",
    "filePath",
    "TargetFile",
    "AbsolutePath",
  ]) {
    if (typeof args[key] === "string" && args[key]) return args[key] as string;
  }
  return undefined;
}

function resultMap<TRaw>(
  messages: ContextMessage<TRaw>[],
): Map<string, ContextMessage<TRaw>> {
  return new Map(
    messages.flatMap((message) =>
      message.toolResult ? [[message.toolResult.callId, message] as const] : [],
    ),
  );
}

function rounds<TRaw>(messages: ContextMessage<TRaw>[]): Round<TRaw>[] {
  return messages.flatMap((message, index) =>
    message.toolCalls.length
      ? [{ index, message, calls: message.toolCalls }]
      : [],
  );
}

function successful<TRaw>(
  call: ToolCall,
  results: Map<string, ContextMessage<TRaw>>,
): boolean {
  const result = results.get(call.id);
  return Boolean(result?.toolResult && !result.toolResult.isError);
}

function consumedDiscovery<TRaw>(
  messages: ContextMessage<TRaw>[],
): Set<number> {
  const results = resultMap(messages);
  const allRounds = rounds(messages);
  const successfulRound = (round: Round<TRaw>): boolean =>
    round.calls.every((call) => successful(call, results));
  const hasLater = (
    index: number,
    predicate: (call: ToolCall) => boolean,
  ): boolean =>
    allRounds.some(
      (round) =>
        round.index > index &&
        successfulRound(round) &&
        round.calls.some(predicate),
    );

  const consumed = new Set<number>();
  for (const round of allRounds) {
    if (!round.calls.every(isDiscovery) || !successfulRound(round)) continue;
    const output = round.calls
      .map((call) => results.get(call.id)?.text ?? "")
      .join("\n")
      .trim();
    if (
      hasLater(round.index, isMutation) ||
      (round.calls.every(isListing) && hasLater(round.index, isRead)) ||
      ((!output || output === "(no output)") &&
        allRounds.some((candidate) => candidate.index > round.index))
    )
      consumed.add(round.index);
  }
  return consumed;
}

function consumedReads<TRaw>(messages: ContextMessage<TRaw>[]): Set<number> {
  const results = resultMap(messages);
  const allRounds = rounds(messages);
  const consumed = new Set<number>();

  for (const round of allRounds) {
    const reads = round.calls
      .filter(isRead)
      .filter((call) => successful(call, results));
    if (!reads.length) continue;
    const mutation = allRounds.find(
      (candidate) =>
        candidate.index > round.index &&
        candidate.calls.some(
          (call) =>
            isMutation(call) &&
            successful(call, results) &&
            reads.some(
              (read) => filePath(read.arguments) === filePath(call.arguments),
            ),
        ),
    );
    if (!mutation) continue;
    const graceObserved = allRounds.some(
      (candidate) =>
        candidate.index > mutation.index &&
        candidate.calls.some((call) => successful(call, results)),
    );
    if (graceObserved) consumed.add(round.index);
  }
  return consumed;
}

function fingerprint(calls: ToolCall[]): string {
  return JSON.stringify(
    calls.map((call) => ({ name: call.name, arguments: call.arguments })),
  );
}

function projectTurn<TRaw>(
  messages: ContextMessage<TRaw>[],
  current: boolean,
  activeRounds: Set<number> = new Set(),
): ContextMessage<TRaw>[] {
  if (messages.length <= 1) return messages;
  const user = messages[0];
  if (!user) return messages;

  if (!current) {
    const finalAssistant = messages.findLastIndex(
      (message) => message.role === "assistant",
    );
    if (finalAssistant < 0) return [user];
    const final = messages[finalAssistant];

    const turnRounds = rounds(messages);
    const activeInTurn = turnRounds.filter((r) => activeRounds.has(r.index));
    if (activeInTurn.length > 0) {
       // If there's active evidence in this old turn, we can't just collapse to final assistant.
       // We need to preserve those rounds.
       // For simplicity and correctness, if it's an old turn with active evidence,
       // we fallback to treating it like a "current" turn for projection purposes
       // but without the duplication removal if we want to be strict,
       // or just let the current projection logic handle it.
       return projectTurn(messages, true, activeRounds);
    }

    if (!final?.toolCalls.length) return [user, final];
    return [user, ...messages.slice(finalAssistant)];
  }

  const discovery = consumedDiscovery(messages);
  const staleReads = consumedReads(messages);
  const candidates = rounds(messages).filter(
    (round) => !discovery.has(round.index) && !staleReads.has(round.index),
  );
  if (!candidates.length) return messages;

  const selected: Round<TRaw>[] = [];
  const seen = new Set<string>();
  for (let index = candidates.length - 1; index >= 0; index--) {
    const round = candidates[index];
    if (!round) continue;
    const key = fingerprint(round.calls);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(round);
  }
  selected.reverse();

  const results = resultMap(messages);
  const projected = [user];
  for (const round of selected) {
    projected.push({
      ...round.message,
      raw: round.message.toolOnlyRaw ?? round.message.raw,
    });
    for (const call of round.calls) {
      const result = results.get(call.id);
      if (result) projected.push(result);
    }
  }
  return projected;
}

function projectionDetails<TRaw>(
  original: ContextMessage<TRaw>[],
  projected: ContextMessage<TRaw>[],
): { retired: RetirementCounts; hotEvidence: EvidenceLease[] } {
  const keptIds = new Set(
    projected.flatMap((message) => message.toolCalls.map((call) => call.id)),
  );
  const keptFingerprints = new Set(
    projected.flatMap((message) =>
      message.toolCalls.length ? [fingerprint(message.toolCalls)] : [],
    ),
  );
  const lastUser = original.findLastIndex((message) => message.role === "user");
  const retired: RetirementCounts = {
    duplicate: 0,
    discovery: 0,
    staleRead: 0,
    completedTurn: 0,
  };

  for (const [index, message] of original.entries()) {
    const calls = message.toolCalls;
    if (!calls.length || calls.some((call) => keptIds.has(call.id))) continue;
    if (index < lastUser) {
      retired.completedTurn++;
    } else if (calls.every(isDiscovery)) {
      retired.discovery++;
    } else if (keptFingerprints.has(fingerprint(calls))) {
      retired.duplicate++;
    } else if (calls.some(isRead)) {
      retired.staleRead++;
    } else {
      retired.completedTurn++;
    }
  }

  const results = resultMap(projected);
  const calls = projected.flatMap((message, index) =>
    message.toolCalls.map((call) => ({ call, index })),
  );
  const latestReads = new Map<string, EvidenceLease>();
  for (const { call, index } of calls) {
    if (!isRead(call)) continue;
    const path = filePath(call.arguments);
    const result = results.get(call.id);
    if (!path || !result || result.toolResult?.isError) continue;
    const consumed = calls.some(
      (candidate) =>
        candidate.index > index &&
        isMutation(candidate.call) &&
        filePath(candidate.call.arguments) === path &&
        successful(candidate.call, results),
    );
    latestReads.set(path, {
      path,
      version: createHash("sha256")
        .update(result.text)
        .digest("hex")
        .slice(0, 12),
      state: consumed ? "consumed" : "active",
      toolCallId: call.id,
    });
  }
  return { retired, hotEvidence: [...latestReads.values()] };
}

export function projectContext<TRaw>(
  messages: ContextMessage<TRaw>[],
  keepRecentTurns = 2,
): ProjectionResult<TRaw> {
  const starts = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (!starts.length) {
    const chars = messages.reduce(
      (sum, message) => sum + message.text.length,
      0,
    );
    return {
      messages: messages.map((message) => message.raw),
      retiredMessages: 0,
      retiredTurns: 0,
      originalChars: chars,
      projectedChars: chars,
      retired: {
        duplicate: 0,
        discovery: 0,
        staleRead: 0,
        completedTurn: 0,
      },
      hotEvidence: [],
    };
  }

  // Calculate global evidence leases across the entire transcript
  const globalDiscovery = consumedDiscovery(messages);
  const globalStaleReads = consumedReads(messages);
  const activeRounds = new Set<number>();
  for (const round of rounds(messages)) {
    if (!globalDiscovery.has(round.index) && !globalStaleReads.has(round.index)) {
      activeRounds.add(round.index);
    }
  }

  const firstTurn = Math.max(0, starts.length - keepRecentTurns);
  const projected: ContextMessage<TRaw>[] = [];
  for (let turn = firstTurn; turn < starts.length; turn++) {
    const start = starts[turn];
    if (start === undefined) continue;
    const end = starts[turn + 1] ?? messages.length;

    // We need to adjust activeRounds to be relative to the slice start
    const turnActiveRounds = new Set<number>();
    for (const roundIdx of activeRounds) {
      if (roundIdx >= start && roundIdx < end) {
        turnActiveRounds.add(roundIdx - start);
      }
    }

    projected.push(
      ...projectTurn(
        messages.slice(start, end),
        turn === starts.length - 1,
        turnActiveRounds,
      ),
    );
  }

  const originalChars = messages.reduce(
    (sum, message) => sum + message.text.length,
    0,
  );
  const projectedChars = projected.reduce(
    (sum, message) => sum + message.text.length,
    0,
  );
  const details = projectionDetails(messages, projected);
  return {
    messages: projected.map((message) => message.raw),
    retiredMessages: Math.max(0, messages.length - projected.length),
    retiredTurns: firstTurn,
    originalChars,
    projectedChars,
    ...details,
  };
}
