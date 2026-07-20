import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextMessage, ToolCall } from "../core/types";

type MessageShape = AgentMessage & Record<string, unknown>;

export function messageText(message: AgentMessage): string {
  const content = (message as MessageShape).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string"
        ? [value.text]
        : [];
    })
    .join("\n");
}

function toolCalls(message: AgentMessage): ToolCall[] {
  const content = (message as MessageShape).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const value = part as Record<string, unknown>;
    if (
      value.type !== "toolCall" ||
      typeof value.id !== "string" ||
      typeof value.name !== "string"
    )
      return [];
    return [
      {
        id: value.id,
        name: value.name,
        arguments:
          value.arguments && typeof value.arguments === "object"
            ? (value.arguments as Record<string, unknown>)
            : {},
      },
    ];
  });
}

export function normalizeMessage(
  message: AgentMessage,
): ContextMessage<AgentMessage> {
  const shape = message as MessageShape;
  const role =
    shape.role === "user" ||
    shape.role === "assistant" ||
    shape.role === "toolResult"
      ? shape.role
      : "other";
  const calls = toolCalls(message);
  const content = shape.content;
  const toolOnlyRaw =
    role === "assistant" && calls.length && Array.isArray(content)
      ? ({
          ...shape,
          content: content.filter((part) =>
            Boolean(
              part &&
              typeof part === "object" &&
              (part as Record<string, unknown>).type === "toolCall",
            ),
          ),
        } as AgentMessage)
      : undefined;
  return {
    raw: message,
    toolOnlyRaw,
    role,
    text: messageText(message),
    toolCalls: calls,
    toolResult:
      role === "toolResult" &&
      typeof shape.toolCallId === "string" &&
      typeof shape.toolName === "string"
        ? {
            callId: shape.toolCallId,
            toolName: shape.toolName,
            isError: shape.isError === true,
          }
        : undefined,
  };
}

export function normalizeMessages(
  messages: AgentMessage[],
): ContextMessage<AgentMessage>[] {
  return messages.map(normalizeMessage);
}

export function scopeMessagesToGoal(
  messages: AgentMessage[],
  goal: string,
): AgentMessage[] {
  if (!goal) return messages;
  const normalizedGoal = goal.replace(/\s+/g, " ").trim();
  const start = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      messageText(message).replace(/\s+/g, " ").trim() === normalizedGoal,
  );
  return start >= 0 ? messages.slice(start) : messages;
}
