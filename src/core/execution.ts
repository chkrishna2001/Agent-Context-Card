import type {
  ContextMessage,
  ExecutionKind,
  ExecutionRecord,
  ExecutionJournal,
  ToolCall,
} from "./types";

interface Aggregate extends ExecutionRecord {
  fingerprint: string;
  lastIndex: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function significantArgument(
  args: Record<string, unknown>,
): [string, string] | undefined {
  for (const key of [
    "path",
    "file_path",
    "filePath",
    "TargetFile",
    "AbsolutePath",
    "target",
  ]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return [key, value.trim()];
  }
  for (const key of ["command", "query", "pattern", "ref"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim())
      return [key, value.replace(/\s+/g, " ").trim()];
  }
  return undefined;
}

function fingerprint(call: ToolCall): string {
  const argument = significantArgument(call.arguments);
  return argument
    ? `${call.name}:${argument[0]}:${argument[1].toLocaleLowerCase()}`
    : `${call.name}:${JSON.stringify(stableValue(call.arguments))}`;
}

function actionSummary(call: ToolCall): string {
  const argument = significantArgument(call.arguments);
  if (!argument) return call.name;
  const value =
    argument[1].length > 240 ? `${argument[1].slice(0, 239)}…` : argument[1];
  return `${call.name} ${value}`;
}

export function isMutationToolName(name: string): boolean {
  return [
    "edit",
    "write",
    "apply_patch",
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
  ].includes(name.toLocaleLowerCase());
}

function executionKind(call: ToolCall): ExecutionKind {
  const name = call.name.toLocaleLowerCase();
  if (isMutationToolName(name)) return "change";
  const command =
    typeof call.arguments.command === "string" ? call.arguments.command : "";
  if (
    ["bash", "shell", "shell_command", "exec_command"].includes(name) &&
    /(?:^|\s)(?:test|build|lint|typecheck|check|tsc)(?:\s|$)|\b(?:bun|npm|pnpm|yarn|mise)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)\b/i.test(
      command,
    )
  )
    return "validation";
  return "other";
}

function failureDetail(text: string): string | undefined {
  const detail = text.replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  return detail.length > 500 ? `${detail.slice(0, 499)}…` : detail;
}

export function buildExecutionJournal(
  messages: ContextMessage[],
): ExecutionJournal {
  const calls = new Map<string, ToolCall>();
  const aggregates = new Map<string, Aggregate>();
  let index = 0;

  for (const message of messages) {
    for (const call of message.toolCalls) calls.set(call.id, call);
    if (!message.toolResult) continue;
    const call = calls.get(message.toolResult.callId);
    if (!call) continue;
    const key = fingerprint(call);
    const previous = aggregates.get(key);
    aggregates.set(key, {
      fingerprint: key,
      action: actionSummary(call),
      kind: executionKind(call),
      status: message.toolResult.isError ? "failed" : "success",
      count: (previous?.count ?? 0) + 1,
      detail: message.toolResult.isError
        ? failureDetail(message.text)
        : undefined,
      lastIndex: index++,
    });
  }

  const records = [...aggregates.values()].sort(
    (left, right) => left.lastIndex - right.lastIndex,
  );
  const visible = (record: Aggregate): ExecutionRecord => ({
    action: record.action,
    kind: record.kind,
    status: record.status,
    count: record.count,
    detail: record.detail,
  });
  return {
    changes: records
      .filter(
        (record) =>
          record.status === "success" &&
          // An "other" call (neither a mutation nor a recognized test/build/
          // lint invocation) stays hidden the first time - a one-off read or
          // check isn't durable enough to belong on the card. But once the
          // exact same call has happened more than once, the repetition
          // itself is the fact worth surfacing: it's the same signal a full,
          // unprojected transcript gives for free (the model can see it
          // already did this), which a collapsed duplicate round otherwise
          // erases. No keyword classification needed - repetition alone
          // earns visibility.
          (record.kind !== "other" || record.count > 1),
      )
      .map(visible),
    failures: records
      .filter((record) => record.status === "failed")
      .map(visible),
  };
}
