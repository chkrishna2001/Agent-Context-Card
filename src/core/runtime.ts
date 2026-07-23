import { taskGoalFromInput } from "./anchor";
import { buildExecutionJournal } from "./execution";
import { buildProjectCapabilities } from "./project";
import type { ContextMessage, RuntimeCard } from "./types";

type ContinuityState = Pick<RuntimeCard, "taskId" | "plan" | "resumed">;

export function buildRuntimeCard(
  cwd: string,
  goal: string,
  messages: ContextMessage[],
  continuity: ContinuityState = {},
): RuntimeCard {
  const latestRequest = messages
    .filter((message) => message.role === "user")
    .map((message) => taskGoalFromInput(message.text))
    .filter(Boolean)
    .at(-1);
  return {
    goal,
    latestRequest,
    capabilities: buildProjectCapabilities(cwd),
    execution: buildExecutionJournal(messages),
    ...continuity,
  };
}
