import { emptyAnchor, type TaskAnchor } from "./types";

export type TaskBoundary = "continue" | "new";

const CONTINUATION =
  /^(?:now|also|next|then|finally|and|but|please|okay|ok|continue|proceed|validate|test|document|update|fix)\b/i;
const NEW_TASK =
  /^(?:new|unrelated|separate)\s+task\b|^switch\s+to\b|\bnew unrelated task\b/i;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "from",
  "have",
  "into",
  "just",
  "more",
  "need",
  "that",
  "the",
  "then",
  "this",
  "with",
]);

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[a-z0-9_.-]{3,}/g)
      ?.filter((term) => !STOP_WORDS.has(term)) ?? [],
  );
}

export function taskBoundaryForInput(
  input: string,
  previous: { goal: string; latestRequest?: string; settled: boolean },
): TaskBoundary {
  const text = input.trim();
  if (!text || !previous.goal) return "continue";
  if (NEW_TASK.test(text)) return "new";
  if (!previous.settled || CONTINUATION.test(text)) return "continue";

  const prior = terms(previous.latestRequest || previous.goal);
  const overlap = [...terms(text)].filter((term) => prior.has(term)).length;
  return overlap >= 2 ? "continue" : "new";
}

export function taskGoalFromInput(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("!"))
    return "";
  return normalized;
}

export function createTaskAnchor(text: string, turn: number): TaskAnchor {
  const goal = taskGoalFromInput(text);
  return goal ? { goal, createdAtTurn: turn } : emptyAnchor();
}
