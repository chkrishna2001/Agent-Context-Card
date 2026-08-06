import { emptyAnchor, type TaskAnchor } from "./types";

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
