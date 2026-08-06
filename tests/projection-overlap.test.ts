import { expect, test, describe } from "bun:test";
import { projectContext } from "../src/core/projection";
import type { ContextMessage } from "../src/core/types";

describe("projection overlap", () => {
  const baseMessages: ContextMessage<string>[] = [
    {
      raw: "User: Hello",
      role: "user",
      text: "Hello",
      toolCalls: [],
    },
    {
      raw: "Asst: reading main.ts",
      role: "assistant",
      text: "Reading main.ts",
      toolCalls: [
        { id: "1", name: "read", arguments: { path: "src/main.ts" } },
      ],
    },
    {
      raw: "Tool: content of main.ts",
      role: "toolResult",
      text: "console.log('hello world')",
      toolCalls: [],
      toolResult: { callId: "1", toolName: "read", isError: false },
    },
    {
      raw: "Asst: I read main.ts",
      role: "assistant",
      text: "I read main.ts",
      toolCalls: [],
    },
  ];

  test("stale read is kept when current user turn references file path", () => {
    const messages: ContextMessage<string>[] = [
      ...baseMessages,
      {
        raw: "Asst: writing main.ts",
        role: "assistant",
        text: "Writing main.ts",
        toolCalls: [
          {
            id: "2",
            name: "write",
            arguments: { path: "src/main.ts", content: "new content" },
          },
        ],
      },
      {
        raw: "Tool: ok",
        role: "toolResult",
        text: "ok",
        toolCalls: [],
        toolResult: { callId: "2", toolName: "write", isError: false },
      },
      {
        raw: "Asst: reading other.ts",
        role: "assistant",
        text: "Reading other.ts",
        toolCalls: [{ id: "3", name: "read", arguments: { path: "other.ts" } }],
      },
      {
        raw: "Tool: other content",
        role: "toolResult",
        text: "other content",
        toolCalls: [],
        toolResult: { callId: "3", toolName: "read", isError: false },
      },
      {
        raw: "Asst: Done",
        role: "assistant",
        text: "Done",
        toolCalls: [],
      },
      {
        raw: "User: What was in src/main.ts before the change?",
        role: "user",
        text: "What was in src/main.ts before the change?",
        toolCalls: [],
      },
    ];

    const projectedResult = projectContext(messages);
    const hasMainRead = projectedResult.messages.some(
      (m) => m && m.includes("main.ts"),
    );
    expect(hasMainRead).toBe(true);
  });

  test("stale discovery is kept when current user turn references search term", () => {
    const messages: ContextMessage<string>[] = [
      {
        raw: "User: Find all tests",
        role: "user",
        text: "Find all tests",
        toolCalls: [],
      },
      {
        raw: "Asst: grepping test_case",
        role: "assistant",
        text: "Grepping test_case",
        toolCalls: [
          { id: "1", name: "grep", arguments: { pattern: "test_case" } },
        ],
      },
      {
        raw: "Tool: found 2 matches",
        role: "toolResult",
        text: "found 2 matches",
        toolCalls: [],
        toolResult: { callId: "1", toolName: "grep", isError: false },
      },
      {
        raw: "Asst: reading main.ts",
        role: "assistant",
        text: "Reading main.ts",
        toolCalls: [
          { id: "2", name: "read", arguments: { path: "src/main.ts" } },
        ],
      },
      {
        raw: "Tool: file content",
        role: "toolResult",
        text: "file content",
        toolCalls: [],
        toolResult: { callId: "2", toolName: "read", isError: false },
      },
      {
        raw: "Asst: I found the tests",
        role: "assistant",
        text: "I found the tests",
        toolCalls: [],
      },
      {
        raw: "User: Tell me more about test_case",
        role: "user",
        text: "Tell me more about test_case",
        toolCalls: [],
      },
    ];

    const projectedResult = projectContext(messages);
    const hasGrep = projectedResult.messages.some((m) =>
      m.includes("Asst: grepping test_case"),
    );
    expect(hasGrep).toBe(true);
  });

  test("a large pasted current-turn blob does not blanket-protect incidental overlap", () => {
    // Mirrors a real incident: a user pastes an entire prior assistant
    // response back in to recover lost context. That blob mentions dozens
    // of distinct terms (here "sidecar" among them), so a naive "does the
    // current turn share any word with this call" check would protect
    // nearly every earlier round from retirement, not just the ones the
    // user is actually asking about.
    const distinctFillerTerms = Array.from(
      { length: 45 },
      (_, i) => `topic${i}`,
    ).join(" ");
    const largeBlob = `Here is the plan again: sidecar pattern, endpoints, auth, retries. ${distinctFillerTerms}`;

    const messages: ContextMessage<string>[] = [
      ...baseMessages.map((m) =>
        m.raw === "Asst: reading main.ts"
          ? {
              ...m,
              toolCalls: [
                {
                  id: "1",
                  name: "read",
                  arguments: { path: "src/main.ts", topic: "sidecar" },
                },
              ],
            }
          : m,
      ),
      {
        raw: "Asst: writing main.ts",
        role: "assistant",
        text: "Writing main.ts",
        toolCalls: [
          {
            id: "2",
            name: "write",
            arguments: { path: "src/main.ts", content: "new content" },
          },
        ],
      },
      {
        raw: "Tool: ok",
        role: "toolResult",
        text: "ok",
        toolCalls: [],
        toolResult: { callId: "2", toolName: "write", isError: false },
      },
      {
        raw: "Asst: reading other.ts",
        role: "assistant",
        text: "Reading other.ts",
        toolCalls: [{ id: "3", name: "read", arguments: { path: "other.ts" } }],
      },
      {
        raw: "Tool: other content",
        role: "toolResult",
        text: "other content",
        toolCalls: [],
        toolResult: { callId: "3", toolName: "read", isError: false },
      },
      {
        raw: "Asst: Done",
        role: "assistant",
        text: "Done",
        toolCalls: [],
      },
      {
        raw: "User: large blob",
        role: "user",
        text: largeBlob,
        toolCalls: [],
      },
    ];

    expect(largeBlob).not.toContain("src/main.ts");

    const projectedResult = projectContext(messages);
    const hasMainRead = projectedResult.messages.some(
      (m) => m && m.includes("Asst: reading main.ts"),
    );
    expect(hasMainRead).toBe(false);
  });

  test("existing retirement behavior is unchanged without overlap", () => {
    const messages: ContextMessage<string>[] = [
      ...baseMessages,
      {
        raw: "Asst: writing main.ts",
        role: "assistant",
        text: "Writing main.ts",
        toolCalls: [
          {
            id: "2",
            name: "write",
            arguments: { path: "src/main.ts", content: "new content" },
          },
        ],
      },
      {
        raw: "Tool: ok",
        role: "toolResult",
        text: "ok",
        toolCalls: [],
        toolResult: { callId: "2", toolName: "write", isError: false },
      },
      {
        raw: "Asst: reading other.ts",
        role: "assistant",
        text: "Reading other.ts",
        toolCalls: [{ id: "3", name: "read", arguments: { path: "other.ts" } }],
      },
      {
        raw: "Tool: other content",
        role: "toolResult",
        text: "other content",
        toolCalls: [],
        toolResult: { callId: "3", toolName: "read", isError: false },
      },
      {
        raw: "Asst: Done",
        role: "assistant",
        text: "Done",
        toolCalls: [],
      },
      {
        raw: "User: Something completely unrelated",
        role: "user",
        text: "Something completely unrelated",
        toolCalls: [],
      },
    ];

    const projectedResult = projectContext(messages);
    const hasMainRead = projectedResult.messages.some((m) =>
      m.includes("Asst: reading main.ts"),
    );
    expect(hasMainRead).toBe(false);
  });
});
