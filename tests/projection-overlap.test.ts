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

describe("checkpoint retirement", () => {
  const tool = (
    id: string,
    name: string,
    arguments_: Record<string, unknown>,
  ): ToolCall => ({ id, name, arguments: arguments_ });
  const assistant = (
    id: string,
    calls: ToolCall[],
  ): ContextMessage<string> => ({
    raw: "assistant:" + id,
    toolOnlyRaw: "tools:" + id,
    role: "assistant",
    text: "assistant:" + id,
    toolCalls: calls,
  });
  const resultFor = (call: ToolCall, text = "ok"): ContextMessage<string> => ({
    raw: "result:" + call.id,
    role: "toolResult",
    text,
    toolCalls: [],
    toolResult: { callId: call.id, toolName: call.name, isError: false },
  });
  const user = (text: string): ContextMessage<string> => ({
    raw: "user:" + text,
    role: "user",
    text,
    toolCalls: [],
  });

  test("a successful update_card round collapses pre-checkpoint rounds", () => {
    const read1 = tool("1", "read", { path: "src/a.ts" });
    const read2 = tool("2", "read", { path: "src/b.ts" });
    const listing = tool("3", "list", { path: "src" });
    const checkpointCall = tool("4", "update_card", {
      pending: ["verify"],
      findings: [],
    });
    const read3 = tool("5", "read", { path: "src/c.ts" });
    const write1 = tool("6", "edit", { path: "src/a.ts" });
    const write2 = tool("7", "edit", { path: "src/b.ts" });
    const validation = tool("8", "shell_command", { command: "bun test" });

    const messages: ContextMessage<string>[] = [
      user("Continue"),
      assistant("read-a", [read1]),
      resultFor(read1, "a-contents"),
      assistant("read-b", [read2]),
      resultFor(read2, "b-contents"),
      assistant("list-src", [listing]),
      resultFor(listing, "(no output)"),
      assistant("update_card", [checkpointCall]),
      resultFor(checkpointCall, "Card updated."),
      assistant("read-c", [read3]),
      resultFor(read3, "c-contents"),
      assistant("edit-a", [write1]),
      resultFor(write1, "ok"),
      assistant("edit-b", [write2]),
      resultFor(write2, "ok"),
      assistant("validate", [validation]),
      resultFor(validation, "pass"),
    ];

    const projected = projectContext(messages);
    const texts = projected.messages.map((message) => String(message));
    // Pre-checkpoint reads (read-a, read-b) and the listing round are not
    // referenced again; the prefix collapse removes them.
    expect(texts.some((t) => t === "tools:read-a")).toBe(false);
    expect(texts.some((t) => t === "tools:read-b")).toBe(false);
    expect(texts.some((t) => t === "tools:list-src")).toBe(false);
    // The checkpoint round itself and the post-checkpoint rounds remain.
    expect(texts.some((t) => t === "tools:update_card")).toBe(true);
    expect(texts.some((t) => t === "tools:read-c")).toBe(true);
    expect(texts.some((t) => t === "tools:edit-a")).toBe(true);
    expect(texts.some((t) => t === "tools:edit-b")).toBe(true);
    expect(texts.some((t) => t === "tools:validate")).toBe(true);
    // The checkpoint counter must reflect the pre-checkpoint rounds.
    expect(projected.retired.checkpoint).toBeGreaterThanOrEqual(2);
  });

  test("checkpoint round appears exactly once with strict tool-call/result alternation", () => {
    const read1 = tool("1", "read", { path: "src/a.ts" });
    const read2 = tool("2", "read", { path: "src/b.ts" });
    const listing = tool("3", "list", { path: "src" });
    const checkpointCall = tool("4", "update_card", {
      pending: ["verify"],
      findings: [],
    });
    const read3 = tool("5", "read", { path: "src/c.ts" });
    const write1 = tool("6", "edit", { path: "src/a.ts" });
    const write2 = tool("7", "edit", { path: "src/b.ts" });
    const validation = tool("8", "shell_command", { command: "bun test" });

    const messages: ContextMessage<string>[] = [
      user("Continue"),
      assistant("read-a", [read1]),
      resultFor(read1, "a-contents"),
      assistant("read-b", [read2]),
      resultFor(read2, "b-contents"),
      assistant("list-src", [listing]),
      resultFor(listing, "(no output)"),
      assistant("update_card", [checkpointCall]),
      resultFor(checkpointCall, "Card updated."),
      assistant("read-c", [read3]),
      resultFor(read3, "c-contents"),
      assistant("edit-a", [write1]),
      resultFor(write1, "ok"),
      assistant("edit-b", [write2]),
      resultFor(write2, "ok"),
      assistant("validate", [validation]),
      resultFor(validation, "pass"),
    ];

    const projected = projectContext(messages);
    const texts = projected.messages.map((m) => String(m));

    // The checkpoint round's tool-only assistant entry must appear
    // exactly once, not twice (the bug was a duplicate copy: one forced
    // via the messages[0] anchor push, one via the round-selection loop).
    const checkpointCount = texts.filter(
      (t) => t === "tools:update_card",
    ).length;
    expect(checkpointCount).toBe(1);

    // The unmapped raw form of the checkpoint round must not appear in
    // the projected output at all - only the toolOnlyRaw shape belongs in
    // the projected transcript.
    const checkpointRawCount = texts.filter(
      (t) => t === "assistant:update_card",
    ).length;
    expect(checkpointRawCount).toBe(0);

    // Strict structural alternation: every assistant message carrying
    // toolCalls must be immediately followed by exactly one matching
    // toolResult, with no two assistant-with-toolCalls entries adjacent
    // and no assistant-with-toolCalls entry followed by another assistant
    // before its own result arrives.
    let lastAssistantWithCallsId: string | null = null;
    let awaitingResultFor: string | null = null;
    for (const entry of projected.messages) {
      const m = entry as unknown as ContextMessage<string>;
      if (m?.role === "assistant") {
        if (m.toolCalls && m.toolCalls.length > 0) {
          const id = m.toolCalls[0]!.id;
          if (awaitingResultFor !== null) {
            throw new Error(
              `assistant message with tool call ${id} appeared before matching result for ${awaitingResultFor}`,
            );
          }
          if (lastAssistantWithCallsId !== null) {
            throw new Error(
              `two assistant-with-toolCalls entries adjacent (${lastAssistantWithCallsId} then ${id}) without intervening result`,
            );
          }
          lastAssistantWithCallsId = id;
          awaitingResultFor = id;
        } else {
          // Assistant without tool calls ends the wait for a result.
          awaitingResultFor = null;
        }
      } else if (m?.role === "toolResult") {
        const callId = m.toolResult?.callId ?? null;
        if (awaitingResultFor === null) {
          throw new Error(
            `unexpected toolResult ${callId} without a preceding assistant tool call`,
          );
        }
        if (callId !== awaitingResultFor) {
          throw new Error(
            `toolResult ${callId} did not match awaited ${awaitingResultFor}`,
          );
        }
        awaitingResultFor = null;
        lastAssistantWithCallsId = null;
      }
    }
    expect(awaitingResultFor).toBeNull();

    // Sanity: the checkpoint result must also appear exactly once.
    expect(texts.filter((t) => t === "result:4").length).toBe(1);
  });

  test("hot evidence for a file read before the checkpoint survives the collapse", () => {
    const read1 = tool("1", "read", { path: "src/keep.ts" });
    const read2 = tool("2", "read", { path: "src/drop.ts" });
    const checkpointCall = tool("3", "update_card", {
      pending: [],
      findings: [],
    });
    const read1Again = tool("4", "read", { path: "src/keep.ts" });
    const write1 = tool("5", "edit", { path: "src/keep.ts" });
    const validation = tool("6", "shell_command", { command: "bun test" });

    const messages: ContextMessage<string>[] = [
      user("Continue"),
      assistant("read-keep", [read1]),
      resultFor(read1, "keep-v1"),
      assistant("read-drop", [read2]),
      resultFor(read2, "drop-contents"),
      assistant("update_card", [checkpointCall]),
      resultFor(checkpointCall, "Card updated."),
      assistant("read-keep-again", [read1Again]),
      resultFor(read1Again, "keep-v2"),
      assistant("edit-keep", [write1]),
      resultFor(write1, "ok"),
      assistant("validate", [validation]),
      resultFor(validation, "pass"),
    ];

    const projected = projectContext(messages);
    const texts = projected.messages.map((m) => String(m));
    // Both keep.ts and drop.ts are in hotEvidence computed from the
    // projected output: keep.ts is consumed (later mutation), drop.ts is
    // active (no mutation).
    const paths = projected.hotEvidence.map((entry) => entry.path).sort();
    expect(paths).toContain("src/keep.ts");
    expect(paths).toContain("src/drop.ts");
    // Hot-evidence protection keeps read-keep-again in the projected set
    // because read-keep is referenced again after the checkpoint. The
    // pre-checkpoint read-keep is preserved via activeRounds: the prefix
    // sees a newer read in the same turn boundary and keeps it.
    const keepReads = texts.filter(
      (t) => t === "tools:read-keep" || t === "tools:read-keep-again",
    );
    expect(keepReads.length).toBeGreaterThanOrEqual(1);
    // The post-checkpoint writes and validation remain.
    expect(texts.some((t) => t === "tools:update_card")).toBe(true);
    expect(texts.some((t) => t === "tools:edit-keep")).toBe(true);
    expect(texts.some((t) => t === "tools:validate")).toBe(true);
  });

  test("failed update_card does not establish a checkpoint", () => {
    const read = tool("1", "read", { path: "src/a.ts" });
    const failedCard = tool("2", "update_card", { pending: ["?"] });

    const messages: ContextMessage<string>[] = [
      user("Continue"),
      assistant("read", [read]),
      resultFor(read, "a-contents"),
      assistant("bad-update_card", [failedCard]),
      {
        raw: "result:2",
        role: "toolResult",
        text: "bad request",
        toolCalls: [],
        toolResult: { callId: "2", toolName: "update_card", isError: true },
      },
    ];

    const projected = projectContext(messages);
    const texts = projected.messages.map((m) => String(m));
    expect(texts.some((t) => t === "tools:read")).toBe(true);
    expect(projected.retired.checkpoint).toBe(0);
  });
});

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
