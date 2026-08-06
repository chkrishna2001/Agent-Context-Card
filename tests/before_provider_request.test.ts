import { describe, expect, test } from "bun:test";
import { tryForceUpdateCardToolCall } from "../src/pi/before_provider_request";

describe("before_provider_request.ts", () => {
  test("tries to force update_card tool when conditions are met", () => {
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [
        {
          type: "function",
          function: {
            name: "update_card",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
      ],
      tool_choice: undefined,
    };

    const forced = tryForceUpdateCardToolCall(payload);

    expect(forced).toBeDefined();
    const toolsArrayResult = (forced as any).tools;
    expect(Array.isArray(toolsArrayResult)).toBe(true);
    expect(toolsArrayResult).toHaveLength(1);
    expect(toolsArrayResult[0].function.name).toBe("update_card");
    expect((forced as any).tool_choice).toEqual({
      type: "function",
      function: { name: "update_card" },
    });
  });

  test("gracefully no-ops when update_card tool is not in tools array", () => {
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
      tool_choice: undefined,
    };

    const forced = tryForceUpdateCardToolCall(payload);

    expect(forced).toBeUndefined();
  });

  test("gracefully no-ops when payload has tool_choice already set", () => {
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
      tool_choice: { type: "auto" },
    };

    const forced = tryForceUpdateCardToolCall(payload);

    expect(forced).toBeUndefined();
  });

  test("gracefully no-ops when messages is not an array", () => {
    const payload = {
      model: "test-model",
      messages: "not an array",
      tools: [
        {
          type: "function",
          function: {
            name: "update_card",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
      ],
      tool_choice: undefined,
    };

    const forced = tryForceUpdateCardToolCall(payload);

    expect(forced).toBeUndefined();
  });

  test("gracefully no-ops when messages is missing", () => {
    const payload = {
      model: "test-model",
      tools: [
        {
          type: "function",
          function: {
            name: "update_card",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
      ],
      tool_choice: undefined,
    };

    const forced = tryForceUpdateCardToolCall(payload);

    expect(forced).toBeUndefined();
  });

  test("gracefully no-ops when tools is not an array", () => {
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: "not an array",
      tool_choice: undefined,
    };

    const forced = tryForceUpdateCardToolCall(payload);

    expect(forced).toBeUndefined();
  });

  test("gracefully no-ops when tools is missing", () => {
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tool_choice: undefined,
    };

    const forced = tryForceUpdateCardToolCall(payload);

    expect(forced).toBeUndefined();
  });

  test("gracefully no-ops when payload is null or undefined", () => {
    expect(tryForceUpdateCardToolCall(undefined)).toBeUndefined();
    expect(tryForceUpdateCardToolCall(null)).toBeUndefined();
  });
});