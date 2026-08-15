import { createHash } from "node:crypto";
import { terms } from "./lexical";
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

function isUpdateCardCall(call: ToolCall): boolean {
  return call.name === "update_card";
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
    message.toolCalls?.length
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

// Above this many distinct terms, the current-turn text is no longer a
// focused reference to specific evidence (e.g. a whole prior response
// pasted back in) and generic term overlap stops being a meaningful signal
// of relevance — nearly everything shares a token with a large enough blob.
const MAX_RELEVANCE_TERMS = 40;

function hasReferenceOverlap<TRaw>(
  round: Round<TRaw>,
  userText: string,
): boolean {
  const userTerms = terms(userText);
  if (userTerms.size === 0) return false;

  for (const call of round.calls) {
    const path = filePath(call.arguments);
    if (path && userText.toLowerCase().includes(path.toLowerCase()))
      return true;

    if (userTerms.size > MAX_RELEVANCE_TERMS) continue;

    const callText = [command(call), JSON.stringify(call.arguments)].join(" ");
    const callTerms = terms(callText);
    for (const term of callTerms) {
      if (userTerms.has(term)) return true;
    }
  }
  return false;
}

function consumedDiscovery<TRaw>(
  messages: ContextMessage<TRaw>[],
  currentTurnText: string | null = null,
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
    ) {
      if (currentTurnText && hasReferenceOverlap(round, currentTurnText)) {
        continue;
      }
      consumed.add(round.index);
    }
  }
  return consumed;
}

function consumedReads<TRaw>(
  messages: ContextMessage<TRaw>[],
  currentTurnText: string | null = null,
): Set<number> {
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
    if (graceObserved) {
      if (currentTurnText && hasReferenceOverlap(round, currentTurnText)) {
        continue;
      }
      consumed.add(round.index);
    }
  }
  return consumed;
}

// Paths an update_card call's findings cite as sources, so a raw read of
// that path can retire once the distilling finding has survived a round.
function findingSources(call: ToolCall): string[] {
  if (!isUpdateCardCall(call)) return [];
  const findings = call.arguments.findings;
  if (!Array.isArray(findings)) return [];
  const paths: string[] = [];
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    const sources = (finding as { sources?: unknown }).sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (typeof source === "string") paths.push(source);
    }
  }
  return paths;
}

function consumedByFinding<TRaw>(
  messages: ContextMessage<TRaw>[],
  currentTurnText: string | null = null,
): Set<number> {
  const results = resultMap(messages);
  const allRounds = rounds(messages);
  const consumed = new Set<number>();

  for (const round of allRounds) {
    const reads = round.calls
      .filter(isRead)
      .filter((call) => successful(call, results));
    if (!reads.length) continue;
    const citation = allRounds.find(
      (candidate) =>
        candidate.index > round.index &&
        candidate.calls.some(
          (call) =>
            successful(call, results) &&
            findingSources(call).some((path) =>
              reads.some((read) => filePath(read.arguments) === path),
            ),
        ),
    );
    if (!citation) continue;
    const graceObserved = allRounds.some(
      (candidate) =>
        candidate.index > citation.index &&
        candidate.calls.some((call) => successful(call, results)),
    );
    if (graceObserved) {
      if (currentTurnText && hasReferenceOverlap(round, currentTurnText)) {
        continue;
      }
      consumed.add(round.index);
    }
  }
  return consumed;
}

// Whether any assistant-authored content after `index` engages with `path`
// again: its own later text, a later tool call's resolved file path, or a
// later tool call's raw arguments (covers a bash command or grep pattern
// naming the file without it being the call's structured "path" argument).
// Deliberately excludes toolResult text - that's not agent-authored, and a
// huge unrelated result coincidentally containing the path string would be
// a false signal of continued relevance, not genuine re-engagement.
function referencedAfter<TRaw>(
  messages: ContextMessage<TRaw>[],
  index: number,
  path: string,
): boolean {
  const needle = path.toLowerCase();
  for (let i = index + 1; i < messages.length; i++) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    if (message.text && message.text.toLowerCase().includes(needle))
      return true;
    for (const call of message.toolCalls ?? []) {
      if (filePath(call.arguments) === path) return true;
      if (JSON.stringify(call.arguments).toLowerCase().includes(needle))
        return true;
    }
  }
  return false;
}

// A read nothing ever comes back to: no later mutation (consumedReads
// already covers that), no later finding citation (consumedByFinding
// already covers that), and no later assistant text or tool call mentions
// its path at all. Unlike a round-count cutoff, this has no magic
// threshold and is recomputed fresh against the full transcript on every
// request - if the agent genuinely returns to the path in a later round,
// referencedAfter flips true and the read stops being disuse-eligible, so
// nothing that's actually back in use stays retired.
function consumedByDisuse<TRaw>(
  messages: ContextMessage<TRaw>[],
  currentTurnText: string | null = null,
): Set<number> {
  const results = resultMap(messages);
  const allRounds = rounds(messages);
  const consumed = new Set<number>();

  for (const round of allRounds) {
    const reads = round.calls
      .filter(isRead)
      .filter((call) => successful(call, results));
    if (!reads.length) continue;
    // Mirrors the graceObserved check in consumedReads/consumedByFinding: a
    // failed later call isn't genuine subsequent activity, so it can't be
    // the grace round that lets this read be judged abandoned.
    const graceObserved = allRounds.some(
      (candidate) =>
        candidate.index > round.index &&
        candidate.calls.some((call) => successful(call, results)),
    );
    if (!graceObserved) continue;
    const stillEngaged = reads.some((read) => {
      const path = filePath(read.arguments);
      return !path || referencedAfter(messages, round.index, path);
    });
    if (stillEngaged) continue;
    if (currentTurnText && hasReferenceOverlap(round, currentTurnText)) {
      continue;
    }
    consumed.add(round.index);
  }
  return consumed;
}

function fingerprint(calls: ToolCall[]): string {
  return JSON.stringify(
    calls.map((call) => ({ name: call.name, arguments: call.arguments })),
  );
}

// The most recent successful update_card round in `messages` defines a
// checkpoint boundary. Returns its local slice-relative round index, or
// undefined if none. A checkpoint round's tool calls must all be
// update_card (with no discovery/read/mutation mixed in) so the boundary
// is unambiguous and the round itself never collides with hot-evidence
// logic. Failed update_card attempts do not establish a boundary.
function checkpointRoundIndex<TRaw>(
  messages: ContextMessage<TRaw>[],
  results: Map<string, ContextMessage<TRaw>>,
): number | undefined {
  const allRounds = rounds(messages);
  let checkpoint: number | undefined;
  for (const round of allRounds) {
    if (!round.calls.every(isUpdateCardCall)) continue;
    if (!round.calls.every((call) => successful(call, results))) continue;
    checkpoint = round.index;
  }
  return checkpoint;
}

// Splits a turn around the checkpoint so the prefix collapses the same
// way as an old turn, while the suffix keeps the full current-turn logic.
// projectTurn(current=true) hard-codes "messages[0] is the user turn
// anchor" and unconditionally re-pushes it; the suffix starts at the
// checkpoint round itself (an assistant message), so we prepend the
// turn's real user message as a placeholder, shift suffixActive to the
// new indices, then strip the placeholder back out so the prefix's own
// output still owns the single canonical copy of the user message.
function projectCheckpointedTurn<TRaw>(
  messages: ContextMessage<TRaw>[],
  activeRounds: Set<number>,
): { projected: ContextMessage<TRaw>[]; checkpoint: number | undefined } {
  const results = resultMap(messages);
  const checkpoint = checkpointRoundIndex(messages, results);
  if (checkpoint === undefined || checkpoint <= 1) {
    return {
      projected: projectTurn(messages, true, activeRounds),
      checkpoint: undefined,
    };
  }

  const prefix = messages.slice(0, checkpoint);
  const suffix = messages.slice(checkpoint);

  const prefixActive = new Set<number>();
  for (const idx of activeRounds) {
    if (idx < checkpoint) prefixActive.add(idx);
  }

  const projectedPrefix = projectTurn(prefix, false, prefixActive);
  const realUser = prefix[0];
  const suffixActive = new Set<number>();
  for (const idx of activeRounds) {
    if (idx >= checkpoint) suffixActive.add(idx - checkpoint + 1);
  }
  const projectedSuffix = projectTurn(
    realUser ? [realUser, ...suffix] : suffix,
    true,
    suffixActive,
  );
  const suffixOutput = realUser ? projectedSuffix.slice(1) : projectedSuffix;
  return {
    projected: [...projectedPrefix, ...suffixOutput],
    checkpoint,
  };
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
      // Old turn with active evidence: keep it as if it were current
      // but using the globally calculated activeRounds.
      return projectTurn(messages, true, activeRounds);
    }

    if (!final?.toolCalls.length) return [user, final];
    return [user, ...messages.slice(finalAssistant)];
  }
  const currentTurnText =
    messages.filter((m) => m.role === "user").slice(-1)[0]?.text ?? null;

  const discovery = consumedDiscovery(messages, currentTurnText);
  const staleReads = consumedReads(messages, currentTurnText);
  const findingConsumed = consumedByFinding(messages, currentTurnText);
  const disused = consumedByDisuse(messages, currentTurnText);
  // activeRounds is the caller's global-truth view of this same slice
  // (computed once, up front, over the FULL transcript, then index-shifted
  // to this slice - see turnActiveRounds/prefixActive/suffixActive). Local
  // recomputation above only sees this slice, so a round whose sole later
  // reference lives outside it (e.g. across a checkpoint's prefix/suffix
  // split, or in a different kept turn) can look orphaned here even though
  // the global computation - which saw that later reference - correctly
  // judged it still active. Membership in activeRounds therefore overrides
  // a local exclusion: it can only ever ADD back a round the global pass
  // already vouched for, never exclude one the local pass would have kept,
  // so intentional retirement for rounds where local and global agree
  // (the common case) is untouched.
  const candidates = rounds(messages).filter(
    (round) =>
      activeRounds.has(round.index) ||
      (!discovery.has(round.index) &&
        !staleReads.has(round.index) &&
        !findingConsumed.has(round.index) &&
        !disused.has(round.index)),
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
  checkpointIndex: number | undefined = undefined,
  findingConsumedIndices: Set<number> = new Set(),
  disusedIndices: Set<number> = new Set(),
): { retired: RetirementCounts; hotEvidence: EvidenceLease[] } {
  const keptIds = new Set(
    projected.flatMap(
      (message) => message.toolCalls?.map((call) => call.id) ?? [],
    ),
  );
  const keptFingerprints = new Set(
    projected.flatMap((message) =>
      message.toolCalls?.length ? [fingerprint(message.toolCalls)] : [],
    ),
  );
  const lastUser = original.findLastIndex((message) => message.role === "user");
  const retired: RetirementCounts = {
    duplicate: 0,
    discovery: 0,
    staleRead: 0,
    completedTurn: 0,
    checkpoint: 0,
    findingConsumed: 0,
    disused: 0,
  };

  for (const [index, message] of original.entries()) {
    if (index < lastUser) continue;
    const calls = message.toolCalls;
    if (!calls?.length) continue;
    if (calls.every(isUpdateCardCall)) continue;
    if (calls.some((call) => keptIds.has(call.id))) continue;
    if (checkedInSameRound(calls, keptFingerprints)) {
      retired.duplicate++;
    } else if (calls.every(isDiscovery)) {
      retired.discovery++;
    } else if (calls.some(isRead)) {
      // Reads not in the projected set: cited by a later finding, never
      // referenced again by anything, stale (mutation happened with the
      // grace boundary), kept under activeRounds, or collapsed by the
      // checkpoint. The two specific automatic/agent-driven reasons are
      // checked first - a read either of them explains may also sit
      // before a checkpoint boundary, and that's still the more specific
      // reason, not a generic checkpoint collapse.
      if (findingConsumedIndices.has(index)) {
        retired.findingConsumed++;
      } else if (disusedIndices.has(index)) {
        retired.disused++;
      } else if (
        checkpointIndex !== undefined &&
        index < checkpointIndex &&
        !isInActiveRounds(original, index)
      ) {
        retired.checkpoint++;
      } else {
        retired.staleRead++;
      }
    } else if (checkpointIndex !== undefined && index < checkpointIndex) {
      retired.checkpoint++;
    } else {
      retired.completedTurn++;
    }
  }

  const results = resultMap(projected);
  const calls = projected.flatMap(
    (message, index) =>
      message.toolCalls?.map((call) => ({ call, index })) ?? [],
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
        successful(candidate.call, results) &&
        ((isMutation(candidate.call) &&
          filePath(candidate.call.arguments) === path) ||
          findingSources(candidate.call).includes(path)),
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

function checkedInSameRound(
  calls: ToolCall[],
  keptFingerprints: Set<string>,
): boolean {
  return keptFingerprints.has(fingerprint(calls));
}

function isInActiveRounds<TRaw>(
  original: ContextMessage<TRaw>[],
  index: number,
): boolean {
  const round = original[index];
  if (!round?.toolCalls?.length) return false;
  const path = filePath(round.toolCalls[0]!.arguments);
  if (!path) return false;
  for (let i = index + 1; i < original.length; i += 1) {
    const candidate = original[i];
    if (!candidate?.toolCalls?.length) continue;
    for (const call of candidate.toolCalls) {
      if (isRead(call) && filePath(call.arguments) === path) return true;
    }
  }
  return false;
}

export function projectContext<TRaw>(
  messages: ContextMessage<TRaw>[],
  keepRecentTurns = 2,
): ProjectionResult<TRaw> {
  const starts = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (!starts.length) {
    const originalChars = messages.reduce(
      (sum, message) => sum + (message.text?.length ?? 0),
      0,
    );
    return {
      messages: messages.map((message) => message.raw),
      retiredMessages: 0,
      retiredTurns: 0,
      originalChars,
      projectedChars: originalChars,
      retired: {
        duplicate: 0,
        discovery: 0,
        staleRead: 0,
        completedTurn: 0,
        checkpoint: 0,
        findingConsumed: 0,
        disused: 0,
      },
      hotEvidence: [],
    };
  }

  // Calculate global evidence leases across the entire transcript
  const currentTurnText =
    messages.filter((m) => m.role === "user").slice(-1)[0]?.text ?? null;
  const globalDiscovery = consumedDiscovery(messages, currentTurnText);
  const globalStaleReads = consumedReads(messages, currentTurnText);
  const globalFindingConsumed = consumedByFinding(messages, currentTurnText);
  const globalDisused = consumedByDisuse(messages, currentTurnText);
  const activeRounds = new Set<number>();
  for (const round of rounds(messages)) {
    if (
      !globalDiscovery.has(round.index) &&
      !globalStaleReads.has(round.index) &&
      !globalFindingConsumed.has(round.index) &&
      !globalDisused.has(round.index)
    ) {
      activeRounds.add(round.index);
    }
  }

  const firstTurn = Math.max(0, starts.length - keepRecentTurns);
  const projected: ContextMessage<TRaw>[] = [];
  let checkpointRoundIndexGlobal: number | undefined;
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

    const isCurrent = turn === starts.length - 1;
    if (isCurrent) {
      const { projected: turnProjected, checkpoint } = projectCheckpointedTurn(
        messages.slice(start, end),
        turnActiveRounds,
      );
      projected.push(...turnProjected);
      if (checkpoint !== undefined) {
        checkpointRoundIndexGlobal = start + checkpoint;
      }
    } else {
      projected.push(
        ...projectTurn(messages.slice(start, end), false, turnActiveRounds),
      );
    }
  }

  const originalChars = messages.reduce(
    (sum, message) => sum + (message.text?.length ?? 0),
    0,
  );
  const projectedChars = projected.reduce(
    (sum, message) => sum + (message.text?.length ?? 0),
    0,
  );
  const details = projectionDetails(
    messages,
    projected,
    checkpointRoundIndexGlobal,
    globalFindingConsumed,
    globalDisused,
  );
  return {
    messages: projected.map((message) => message.raw),
    retiredMessages: Math.max(0, messages.length - projected.length),
    retiredTurns: firstTurn,
    originalChars,
    projectedChars,
    ...details,
  };
}
