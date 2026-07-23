import { readFile } from "node:fs/promises";

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

const MUTATING_TOOLS = new Set(["apply_patch", "edit", "write"]);

function toolName(event) {
  return String(event.toolName ?? "").toLowerCase();
}

function fileTarget(args = {}) {
  const value = args.path ?? args.filePath ?? args.file_path;
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function toolSignature(event) {
  return `${event.toolName}:${JSON.stringify(stableValue(event.args ?? {}))}`;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

export function parseJsonLines(text) {
  const records = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      errors.push({ line: index + 1, detail: String(error), text: line });
    }
  });
  return { records, errors };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    providerInput: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(target, usage = {}) {
  target.input += number(usage.input);
  target.output += number(usage.output);
  target.cacheRead += number(usage.cacheRead);
  target.cacheWrite += number(usage.cacheWrite);
  target.reasoning += number(usage.reasoning);
  target.totalTokens += number(usage.totalTokens);
  target.providerInput +=
    number(usage.input) + number(usage.cacheRead) + number(usage.cacheWrite);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"])
    target.cost[key] += number(usage.cost?.[key]);
}

export function analyzeTrace(text, durationMs = 0) {
  const { records, errors } = parseJsonLines(text);
  const usage = emptyUsage();
  const requests = [];
  const toolSignatures = new Map();
  const signatureStates = new Map();
  const fileVersions = new Map();
  const pendingTools = new Map();
  const tools = {};
  const stopReasons = {};
  let assistantChars = 0;
  let toolResultChars = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let providerErrors = 0;
  let compactions = 0;
  let retries = 0;
  let turns = 0;
  let globalMutationVersion = 0;
  let sameStateDuplicateToolCalls = 0;

  for (const event of records) {
    if (event.type === "turn_start") turns++;
    if (event.type === "compaction_start") compactions++;
    if (event.type === "auto_retry_start") retries++;
    if (event.type === "tool_execution_start") {
      toolCalls++;
      tools[event.toolName] = (tools[event.toolName] ?? 0) + 1;
      const signature = toolSignature(event);
      toolSignatures.set(signature, (toolSignatures.get(signature) ?? 0) + 1);
      const target = fileTarget(event.args);
      const state =
        toolName(event) === "read" && target
          ? `file:${target}:${fileVersions.get(target) ?? 0}`
          : `global:${globalMutationVersion}`;
      if (signatureStates.get(signature) === state)
        sameStateDuplicateToolCalls++;
      signatureStates.set(signature, state);
      pendingTools.set(event.toolCallId, event);
    }
    if (event.type === "tool_execution_end") {
      const start = pendingTools.get(event.toolCallId);
      pendingTools.delete(event.toolCallId);
      if (start && !event.isError && MUTATING_TOOLS.has(toolName(start))) {
        globalMutationVersion++;
        const target = fileTarget(start.args);
        if (target)
          fileVersions.set(target, (fileVersions.get(target) ?? 0) + 1);
      }
    }
    if (event.type === "tool_execution_end" && event.isError) toolErrors++;
    if (event.type !== "message_end" || !event.message) continue;
    if (event.message.role === "toolResult")
      toolResultChars += contentText(event.message.content).length;
    if (event.message.role !== "assistant") continue;
    assistantChars += contentText(event.message.content).length;
    const reason = event.message.stopReason ?? "unknown";
    stopReasons[reason] = (stopReasons[reason] ?? 0) + 1;
    if (reason === "error") providerErrors++;
    const requestUsage = emptyUsage();
    addUsage(requestUsage, event.message.usage);
    addUsage(usage, event.message.usage);
    requests.push({
      provider: event.message.provider,
      model: event.message.model,
      stopReason: reason,
      usage: requestUsage,
      errorMessage: event.message.errorMessage,
      timestamp: event.message.timestamp,
    });
  }

  return {
    durationMs,
    jsonRecords: records.length,
    jsonErrors: errors,
    providerRequests: requests.length,
    turns,
    usage,
    maxRequestProviderInput: Math.max(
      0,
      ...requests.map((request) => request.usage.providerInput),
    ),
    maxRequestOutput: Math.max(
      0,
      ...requests.map((request) => request.usage.output),
    ),
    toolCalls,
    toolErrors,
    providerErrors,
    duplicateToolCalls: [...toolSignatures.values()].reduce(
      (total, count) => total + Math.max(0, count - 1),
      0,
    ),
    sameStateDuplicateToolCalls,
    tools,
    stopReasons,
    compactions,
    retries,
    assistantChars,
    toolResultChars,
    requests,
  };
}

export function analyzeSession(text) {
  const { records, errors } = parseJsonLines(text);
  const projections = [];
  const taskState = [];
  let messages = 0;
  let customEntries = 0;
  for (const entry of records) {
    if (entry.type === "message") messages++;
    if (entry.type !== "custom") continue;
    customEntries++;
    if (entry.customType === "agent-context-card-audit")
      projections.push(entry.data);
    if (entry.customType === "agent-context-card-task-state-audit")
      taskState.push(entry.data);
  }
  return {
    bytes: Buffer.byteLength(text),
    entries: records.length,
    messages,
    customEntries,
    jsonErrors: errors,
    projections,
    taskState,
  };
}

export async function analyzeSessionFiles(paths) {
  const files = [];
  for (const file of paths) {
    files.push({ file, ...analyzeSession(await readFile(file, "utf8")) });
  }
  return files;
}

export function aggregateTurns(turns) {
  const usage = emptyUsage();
  const tools = {};
  const stopReasons = {};
  const aggregate = {
    durationMs: 0,
    providerRequests: 0,
    turns: 0,
    usage,
    maxRequestProviderInput: 0,
    maxRequestOutput: 0,
    toolCalls: 0,
    toolErrors: 0,
    providerErrors: 0,
    duplicateToolCalls: 0,
    sameStateDuplicateToolCalls: 0,
    tools,
    stopReasons,
    compactions: 0,
    retries: 0,
    assistantChars: 0,
    toolResultChars: 0,
    jsonErrors: 0,
  };
  for (const turn of turns) {
    const metric = turn.trace;
    aggregate.durationMs += metric.durationMs;
    aggregate.providerRequests += metric.providerRequests;
    aggregate.turns += metric.turns;
    addUsage(usage, metric.usage);
    aggregate.maxRequestProviderInput = Math.max(
      aggregate.maxRequestProviderInput,
      metric.maxRequestProviderInput,
    );
    aggregate.maxRequestOutput = Math.max(
      aggregate.maxRequestOutput,
      metric.maxRequestOutput,
    );
    for (const key of [
      "toolCalls",
      "toolErrors",
      "providerErrors",
      "duplicateToolCalls",
      "sameStateDuplicateToolCalls",
      "compactions",
      "retries",
      "assistantChars",
      "toolResultChars",
    ])
      aggregate[key] += metric[key];
    aggregate.jsonErrors += metric.jsonErrors.length;
    for (const [name, count] of Object.entries(metric.tools))
      tools[name] = (tools[name] ?? 0) + count;
    for (const [name, count] of Object.entries(metric.stopReasons))
      stopReasons[name] = (stopReasons[name] ?? 0) + count;
  }
  return aggregate;
}

export function summarizeAudits(sessions) {
  const projections = sessions.flatMap((session) => session.projections ?? []);
  const taskState = sessions.flatMap((session) => session.taskState ?? []);
  const operationCounts = {};
  for (const audit of taskState) {
    const key = `${audit.operation ?? "unknown"}:${audit.status ?? "unknown"}`;
    operationCounts[key] = (operationCounts[key] ?? 0) + 1;
  }
  return {
    projectionRequests: projections.length,
    maxEstimatedProjectedTokens: Math.max(
      0,
      ...projections.map((audit) => number(audit.estimatedProjectedTokens)),
    ),
    maxCardChars: Math.max(
      0,
      ...projections.map((audit) => number(audit.cardChars)),
    ),
    maxOriginalMessages: Math.max(
      0,
      ...projections.map((audit) => number(audit.originalMessages)),
    ),
    maxProjectedMessages: Math.max(
      0,
      ...projections.map((audit) => number(audit.projectedMessages)),
    ),
    retiredMessages: projections.reduce(
      (total, audit) => total + number(audit.retiredMessages),
      0,
    ),
    maxHotEvidence: Math.max(
      0,
      ...projections.map((audit) =>
        Array.isArray(audit.hotEvidence) ? audit.hotEvidence.length : 0,
      ),
    ),
    firstRequestHotEvidence: Array.isArray(projections[0]?.hotEvidence)
      ? projections[0].hotEvidence.length
      : undefined,
    planRevisions: [
      ...new Set(
        projections
          .map((audit) => audit.continuity?.planRevision)
          .filter((revision) => typeof revision === "number"),
      ),
    ],
    maxResumedChanges: Math.max(
      0,
      ...projections.map((audit) => number(audit.continuity?.resumedChanges)),
    ),
    maxResumedFailures: Math.max(
      0,
      ...projections.map((audit) => number(audit.continuity?.resumedFailures)),
    ),
    repositoryChanged: projections.some(
      (audit) => audit.continuity?.repositoryChanged === true,
    ),
    taskState: operationCounts,
  };
}

export function percentChange(baseline, candidate) {
  if (!baseline) return undefined;
  return ((candidate - baseline) / baseline) * 100;
}

export function distribution(values) {
  const sorted = values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (sorted.length === 0)
    return { count: 0, min: null, max: null, mean: null, median: null };
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted.at(-1),
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    median,
  };
}

const REPEAT_METRICS = {
  providerInputTokens: (run) => run.aggregate.usage.providerInput,
  totalTokens: (run) => run.aggregate.usage.totalTokens,
  outputTokens: (run) => run.aggregate.usage.output,
  reasoningTokens: (run) => run.aggregate.usage.reasoning,
  cacheReadTokens: (run) => run.aggregate.usage.cacheRead,
  providerRequests: (run) => run.aggregate.providerRequests,
  toolCalls: (run) => run.aggregate.toolCalls,
  toolErrors: (run) => run.aggregate.toolErrors,
  rawRepeatedSignatures: (run) => run.aggregate.duplicateToolCalls,
  sameStateRepeatedSignatures: (run) =>
    run.aggregate.sameStateDuplicateToolCalls,
  durationMs: (run) => run.aggregate.durationMs,
};

export function summarizeRepeatedRuns(runs) {
  const variantNames = [...new Set(runs.map((run) => run.variant))];
  const variants = {};
  for (const variant of variantNames) {
    const selected = runs.filter((run) => run.variant === variant);
    variants[variant] = {
      runs: selected.length,
      correctness: {
        passed: selected.filter((run) => run.correct === true).length,
        failed: selected.filter((run) => run.correct === false).length,
        ungraded: selected.filter((run) => run.correct === undefined).length,
      },
      metrics: Object.fromEntries(
        Object.entries(REPEAT_METRICS).map(([name, read]) => [
          name,
          distribution(selected.map(read)),
        ]),
      ),
    };
  }
  const baseline = new Map(
    runs
      .filter((run) => run.variant === "baseline")
      .map((run) => [run.repeat, run]),
  );
  const card = new Map(
    runs
      .filter((run) => run.variant === "card")
      .map((run) => [run.repeat, run]),
  );
  const pairedChanges = {};
  for (const [name, read] of Object.entries(REPEAT_METRICS)) {
    const changes = [];
    for (const [repeat, baselineRun] of baseline) {
      const cardRun = card.get(repeat);
      if (!cardRun) continue;
      const change = percentChange(read(baselineRun), read(cardRun));
      if (change !== undefined) changes.push(change);
    }
    pairedChanges[name] = distribution(changes);
  }
  return { variants, pairedChanges };
}
