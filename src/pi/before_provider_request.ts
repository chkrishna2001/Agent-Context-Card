type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

type OpenAIToolChoice = {
  type: "function";
  function: {
    name: string;
  };
};

export function tryForceUpdateCardToolCall(payload: unknown): unknown {
  if (
    payload === undefined ||
    payload === null ||
    typeof payload !== "object"
  ) {
    return undefined;
  }

  const payloadWithOrder = payload as Record<string, unknown>;

  if (!Array.isArray(payloadWithOrder.messages)) {
    return undefined;
  }

  const tools = payloadWithOrder.tools;

  if (!Array.isArray(tools)) {
    return undefined;
  }

  const hasUpdateCard = tools.some(
    (tool): tool is OpenAITool =>
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

  return {
    ...payloadWithOrder,
    tool_choice: {
      type: "function" as const,
      function: { name: "update_card" },
    } satisfies OpenAIToolChoice,
  };
}
