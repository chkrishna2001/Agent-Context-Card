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
    // Mentions src/c.ts so read-c stays referenced and this test keeps
    // isolating checkpoint-collapse behavior rather than also exercising
    // disuse retirement on an incidental, never-revisited read.
    const validation = tool("8", "shell_command", {
      command: "cat src/c.ts",
    });

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

  test("a file mutated after the checkpoint leaves no stale evidence across the collapse", () => {
    const read1 = tool("1", "read", { path: "src/keep.ts" });
    const read2 = tool("2", "read", { path: "src/drop.ts" });
    const checkpointCall = tool("3", "update_card", {
      pending: [],
      findings: [],
    });
    const read1Again = tool("4", "read", { path: "src/keep.ts" });
    const write1 = tool("5", "edit", { path: "src/keep.ts" });
    // Mentions src/drop.ts so it stays referenced; otherwise disuse
    // retirement would also claim it, collapsing the prefix down to just
    // its final round and losing read-keep along the way - a real but
    // unrelated interaction this test isn't trying to isolate.
    const validation = tool("6", "shell_command", {
      command: "cat src/drop.ts",
    });

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
    // Both keep.ts reads (pre-checkpoint and post-checkpoint) are
    // superseded by the edit that follows them - neither snapshot is
    // needed once the model has overwritten the file it read, so keep.ts
    // correctly has no surviving evidence at all rather than an arbitrary
    // one of the two. drop.ts stays active: it's referenced again (the
    // validation step), so nothing retires it.
    const paths = projected.hotEvidence.map((entry) => entry.path).sort();
    expect(paths).not.toContain("src/keep.ts");
    expect(paths).toContain("src/drop.ts");
    const keepReads = texts.filter(
      (t) => t === "tools:read-keep" || t === "tools:read-keep-again",
    );
    expect(keepReads.length).toBe(0);
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

  test("a prefix read only mutated in the suffix, before its own grace round, stays active", () => {
    const readA = tool("1", "read", { path: "src/a.ts" });
    const readB = tool("2", "read", { path: "src/b.ts" });
    const checkpointCall = tool("3", "update_card", {
      pending: [],
      findings: [],
    });
    const mutateA = tool("4", "edit", { path: "src/a.ts" });

    const messages: ContextMessage<string>[] = [
      user("Continue"),
      assistant("read-a", [readA]),
      resultFor(readA, "a-contents"),
      assistant("read-b", [readB]),
      resultFor(readB, "b-contents"),
      assistant("update_card", [checkpointCall]),
      resultFor(checkpointCall, "Card updated."),
      assistant("mutate-a", [mutateA]),
      resultFor(mutateA, "ok"),
    ];

    const projected = projectContext(messages);
    const texts = projected.messages.map((m) => String(m));
    // The suffix mutation hasn't cleared its own grace round yet (nothing
    // follows it), so globally read-a is still active, not yet retired by
    // mutation-consumption - it must survive the collapse.
    expect(texts.some((t) => t === "tools:read-a")).toBe(true);
    expect(texts.some((t) => t === "tools:update_card")).toBe(true);
    expect(texts.some((t) => t === "tools:mutate-a")).toBe(true);
  });

  test("a prefix read only cited by a finding in the suffix, before its own grace round, stays active", () => {
    const readA = tool("1", "read", { path: "src/a.ts" });
    const readB = tool("2", "read", { path: "src/b.ts" });
    const checkpointCall = tool("3", "update_card", {
      pending: [],
      findings: [],
    });
    const citeA = tool("4", "update_card", {
      findings: [
        {
          topic: "a.ts shape",
          detail: "exports foo()",
          sources: ["src/a.ts"],
        },
      ],
    });

    const messages: ContextMessage<string>[] = [
      user("Continue"),
      assistant("read-a", [readA]),
      resultFor(readA, "a-contents"),
      assistant("read-b", [readB]),
      resultFor(readB, "b-contents"),
      assistant("update_card", [checkpointCall]),
      resultFor(checkpointCall, "Card updated."),
      assistant("cite-a", [citeA]),
      resultFor(citeA, "Card updated."),
    ];

    const projected = projectContext(messages);
    const texts = projected.messages.map((m) => String(m));
    // The citing update_card hasn't cleared its own grace round yet, so
    // globally read-a is still active, not yet retired by finding
    // consumption - it must survive the collapse.
    expect(texts.some((t) => t === "tools:read-a")).toBe(true);
    expect(texts.some((t) => t === "tools:update_card")).toBe(true);
    expect(texts.some((t) => t === "tools:cite-a")).toBe(true);
  });

  test("a prefix read only mentioned again in the suffix stays active", () => {
    const readA = tool("1", "read", { path: "src/a.ts" });
    const readB = tool("2", "read", { path: "src/b.ts" });
    const checkpointCall = tool("3", "update_card", {
      pending: [],
      findings: [],
    });
    const mentionA = tool("4", "shell_command", { command: "cat src/a.ts" });

    const messages: ContextMessage<string>[] = [
      user("Continue"),
      assistant("read-a", [readA]),
      resultFor(readA, "a-contents"),
      assistant("read-b", [readB]),
      resultFor(readB, "b-contents"),
      assistant("update_card", [checkpointCall]),
      resultFor(checkpointCall, "Card updated."),
      assistant("mention-a", [mentionA]),
      resultFor(mentionA, "a-contents"),
    ];

    const projected = projectContext(messages);
    const texts = projected.messages.map((m) => String(m));
    // Nothing ever mutates or cites src/a.ts, but the suffix mention means
    // it's never genuinely orphaned either - globally active, must survive
    // the collapse.
    expect(texts.some((t) => t === "tools:read-a")).toBe(true);
    expect(texts.some((t) => t === "tools:update_card")).toBe(true);
    expect(texts.some((t) => t === "tools:mention-a")).toBe(true);
  });
});

describe("finding-sourced retirement", () => {
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

  // Shared shape: two reads, one cited by a finding's sources, one not;
  // a grace round after the citation; a second, later update_card so the
  // citation and its read land together in the same projection pass
  // instead of being split apart by the checkpoint boundary.
  const buildMessages = (userText: string): ContextMessage<string>[] => {
    const readA = tool("1", "read", { path: "src/a.ts" });
    const readB = tool("2", "read", { path: "src/b.ts" });
    const citingUpdate = tool("3", "update_card", {
      findings: [
        {
          topic: "a.ts shape",
          detail: "exports foo()",
          sources: ["src/a.ts"],
        },
      ],
    });
    // Mentions src/b.ts so it stays referenced independent of citation -
    // this fixture isolates finding-citation as a retirement trigger, not
    // disuse, so the "uncited read" baseline needs a reason of its own to
    // stay active rather than accidentally also going disused.
    const grace = tool("4", "shell_command", {
      command: "cat src/b.ts",
    });
    const finalCheckpoint = tool("5", "update_card", { pending: ["done"] });
    const trailing = tool("6", "read", { path: "src/c.ts" });

    return [
      user(userText),
      assistant("read-a", [readA]),
      resultFor(readA, "a-contents"),
      assistant("read-b", [readB]),
      resultFor(readB, "b-contents"),
      assistant("cite-a", [citingUpdate]),
      resultFor(citingUpdate, "Card updated."),
      assistant("grace", [grace]),
      resultFor(grace, "pass"),
      assistant("checkpoint", [finalCheckpoint]),
      resultFor(finalCheckpoint, "Card updated."),
      assistant("read-c", [trailing]),
      resultFor(trailing, "c-contents"),
    ];
  };

  test("a read cited by a later finding's sources retires; an uncited read does not", () => {
    const projected = projectContext(buildMessages("Continue"));
    const texts = projected.messages.map((m) => String(m));

    // src/a.ts was distilled into a finding, so its read retires once the
    // grace round has passed.
    expect(texts.some((t) => t === "tools:read-a")).toBe(false);
    // src/b.ts was never cited, so it's untouched - the baseline case.
    expect(texts.some((t) => t === "tools:read-b")).toBe(true);

    // The retirement is attributed to the finding citation specifically,
    // not folded into the generic staleRead bucket.
    expect(projected.retired.findingConsumed).toBeGreaterThanOrEqual(1);
    expect(projected.retired.staleRead).toBe(0);

    const bLease = projected.hotEvidence.find((e) => e.path === "src/b.ts");
    expect(bLease?.state).toBe("active");
    const aLease = projected.hotEvidence.find((e) => e.path === "src/a.ts");
    if (aLease) expect(aLease.state).not.toBe("active");
  });

  test("a finding-cited read is kept when the current turn text references its path", () => {
    const projected = projectContext(
      buildMessages("Check src/a.ts against the new schema"),
    );
    const texts = projected.messages.map((m) => String(m));

    // Same finding citation as above, but the live request is about
    // src/a.ts directly - the reference-overlap exemption (shared with
    // mutation-based staleRead retirement) keeps it in context rather
    // than retiring evidence the current turn is actively asking about.
    expect(texts.some((t) => t === "tools:read-a")).toBe(true);
  });
});

describe("disuse retirement", () => {
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
  const doneText = (text: string): ContextMessage<string> => ({
    raw: "assistant:" + text,
    role: "assistant",
    text,
    toolCalls: [],
  });

  test("a read nothing ever comes back to retires; one referenced again does not", () => {
    const readX = tool("1", "read", { path: "src/x.ts" });
    const readY = tool("2", "read", { path: "src/y.ts" });
    const mentionY = tool("3", "shell_command", { command: "cat src/y.ts" });

    const messages: ContextMessage<string>[] = [
      user("Investigate"),
      assistant("read-x", [readX]),
      resultFor(readX, "x-contents"),
      assistant("read-y", [readY]),
      resultFor(readY, "y-contents"),
      assistant("mention-y", [mentionY]),
      resultFor(mentionY, "y again"),
      doneText("Done investigating"),
    ];

    const projected = projectContext(messages);
    const texts = projected.messages.map((m) => String(m));

    // Nothing ever mentions src/x.ts again after the read - genuinely
    // orphaned evidence.
    expect(texts.some((t) => t === "tools:read-x")).toBe(false);
    // src/y.ts is referenced again (the cat command), so it stays.
    expect(texts.some((t) => t === "tools:read-y")).toBe(true);
    expect(projected.retired.disused).toBeGreaterThanOrEqual(1);
    expect(projected.retired.staleRead).toBe(0);
  });

  test("retirement is reversible: the same read stays active once something later references it", () => {
    const readX = tool("1", "read", { path: "src/x.ts" });
    const noise = tool("2", "shell_command", { command: "cat unrelated.ts" });
    const mentionXLate = tool("3", "shell_command", {
      command: "cat src/x.ts",
    });

    const withoutLateReference: ContextMessage<string>[] = [
      user("Investigate"),
      assistant("read-x", [readX]),
      resultFor(readX, "x-contents"),
      assistant("noise", [noise]),
      resultFor(noise, "noise-out"),
    ];
    const withLateReference: ContextMessage<string>[] = [
      ...withoutLateReference,
      assistant("mention-x-late", [mentionXLate]),
      resultFor(mentionXLate, "x again"),
    ];

    // Same read, same one-round grace point. Unlike a round-count cutoff,
    // whether it retires depends only on whether anything ever comes back
    // to it - recomputed fresh each time, not decided once and fixed.
    const early = projectContext(withoutLateReference);
    expect(
      early.messages.map((m) => String(m)).some((t) => t === "tools:read-x"),
    ).toBe(false);

    const late = projectContext(withLateReference);
    expect(
      late.messages.map((m) => String(m)).some((t) => t === "tools:read-x"),
    ).toBe(true);
  });

  test("a disuse-eligible read is kept when the current turn text references its path", () => {
    const readX = tool("1", "read", { path: "src/x.ts" });
    const noise = tool("2", "shell_command", { command: "cat unrelated.ts" });

    const messages: ContextMessage<string>[] = [
      user("Check src/x.ts against the schema"),
      assistant("read-x", [readX]),
      resultFor(readX, "x-contents"),
      assistant("noise", [noise]),
      resultFor(noise, "noise-out"),
    ];

    const projected = projectContext(messages);
    const texts = projected.messages.map((m) => String(m));
    expect(texts.some((t) => t === "tools:read-x")).toBe(true);
  });

  test("a failed later call is not enough grace to call a read abandoned", () => {
    const readX = tool("1", "read", { path: "src/x.ts" });
    const failedCall = tool("2", "shell_command", { command: "bun test" });

    const messages: ContextMessage<string>[] = [
      user("Investigate"),
      assistant("read-x", [readX]),
      resultFor(readX, "x-contents"),
      assistant("failed", [failedCall]),
      {
        raw: "result:2",
        role: "toolResult",
        text: "command not found",
        toolCalls: [],
        toolResult: { callId: "2", toolName: "shell_command", isError: true },
      },
    ];

    const projected = projectContext(messages);
    const texts = projected.messages.map((m) => String(m));
    expect(texts.some((t) => t === "tools:read-x")).toBe(true);
  });
});

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
