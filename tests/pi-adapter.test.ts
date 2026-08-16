import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import agentContextCard from "../index";
import {
  ANCHOR_ENTRY_TYPE,
  AUDIT_ENTRY_TYPE,
  CARD_MESSAGE_TYPE,
  CARD_NUDGE_MESSAGE_TYPE,
  CARD_STATE_ENTRY_TYPE,
  TASK_STATE_AUDIT_ENTRY_TYPE,
} from "../src/core/types";
import { scopeMessagesToGoal } from "../src/pi/normalize";

type Handler = (...args: any[]) => any;

function harness(
  cwd = process.cwd(),
  options: { sessionId?: string; hasUI?: boolean } = {},
) {
  const flags = new Map<string, string | boolean>();
  const handlers = new Map<string, Handler[]>();
  const tools: ToolDefinition[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const sentMessages: Array<{ message: any; options?: any }> = [];
  const branch: any[] = [];
  const pi = {
    registerFlag(name: string, options: { default?: string | boolean }) {
      if (options.default !== undefined) flags.set(name, options.default);
    },
    getFlag: (name: string) => flags.get(name),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand() {},
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
      branch.push({ type: "custom", customType, data });
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage(message: any, options?: any) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  agentContextCard(pi);
  const context = {
    cwd,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => options.sessionId,
    },
    model: { provider: "test", id: "model", contextWindow: 128_000 },
    ui: { setStatus() {}, notify() {} },
    hasUI: options.hasUI ?? true,
  } as unknown as ExtensionContext;
  return {
    tools,
    entries,
    sentMessages,
    branch: () => [...branch],
    setFlag(name: string, value: string | boolean) {
      flags.set(name, value);
    },
    replaceBranch(entries: any[]) {
      branch.splice(0, branch.length, ...entries);
    },
    async start() {
      for (const handler of handlers.get("session_start") ?? [])
        await handler({}, context);
    },
    async tree() {
      for (const handler of handlers.get("session_tree") ?? [])
        await handler({}, context);
    },
    async input(text: string) {
      for (const handler of handlers.get("input") ?? [])
        await handler({ text }, context);
      branch.push({
        type: "message",
        message: { role: "user", content: text, timestamp: Date.now() },
      });
    },
    async beforeAgentStart(systemPrompt: string) {
      let result: { systemPrompt?: string } | undefined;
      for (const handler of handlers.get("before_agent_start") ?? []) {
        const returned = await handler(
          {
            prompt: "test",
            systemPrompt: result?.systemPrompt ?? systemPrompt,
          },
          context,
        );
        if (returned !== undefined) result = returned;
      }
      return result;
    },
    async toolExecutionStart(event: {
      toolCallId: string;
      toolName: string;
      args?: any;
    }) {
      for (const handler of handlers.get("tool_execution_start") ?? [])
        await handler(event, context);
    },
    async toolExecutionEnd(event: {
      toolCallId?: string;
      toolName: string;
      isError?: boolean;
      result?: any;
    }) {
      for (const handler of handlers.get("tool_execution_end") ?? [])
        await handler(event, context);
    },
    async call(
      toolCallId: string,
      toolName: string,
      args: any,
      outcome: { isError?: boolean; result?: any } = {},
    ) {
      for (const handler of handlers.get("tool_execution_start") ?? [])
        await handler({ toolCallId, toolName, args }, context);
      for (const handler of handlers.get("tool_execution_end") ?? [])
        await handler(
          {
            toolCallId,
            toolName,
            isError: outcome.isError,
            result: outcome.result,
          },
          context,
        );
    },
    async turnEnd(message: AgentMessage) {
      branch.push({ type: "message", message });
      for (const handler of handlers.get("turn_end") ?? [])
        await handler({ message, toolResults: [] }, context);
    },
    async beforeProviderRequest(payload: unknown) {
      let result: unknown;
      for (const handler of handlers.get("before_provider_request") ?? []) {
        const returned = await handler({ payload }, context);
        if (returned !== undefined) result = returned;
      }
      return result;
    },
    async project(messages: AgentMessage[]) {
      let output: { messages: AgentMessage[] } | undefined;
      for (const handler of handlers.get("context") ?? [])
        output = await handler({ messages }, context);
      return output;
    },
  };
}

describe("Pi adapter", () => {
  test("registers no model-facing tools beyond update_card and keeps audit outside context", async () => {
    const extension = harness();
    await extension.start();
    const output = await extension.project([
      { role: "user", content: "Inspect the project", timestamp: 1 },
    ]);
    expect(extension.tools.map((tool) => tool.name)).toEqual(["update_card"]);
    expect(output?.messages[0]).toMatchObject({
      role: "custom",
      customType: CARD_MESSAGE_TYPE,
    });
    expect(extension.entries.at(-1)?.customType).toBe(AUDIT_ENTRY_TYPE);
    expect(
      (extension.entries.at(-1)?.data as any).continuity.planProjectionMode,
    ).toBe("full");
    expect(
      (extension.entries.at(-1)?.data as any).continuity.planProjectionState,
    ).toBe("none");
    expect(
      (extension.entries.at(-1)?.data as any).continuity.planPhaseFramingMode,
    ).toBe("off");
    expect(
      (extension.entries.at(-1)?.data as any).continuity.planPhaseFramingState,
    ).toBe("none");
    expect(JSON.stringify(output?.messages)).not.toContain(AUDIT_ENTRY_TYPE);
  });

  test("invariant linter strips stale plan directives and records violations", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Create a plan for JIRA-123");
    await extension.turnEnd({
      role: "assistant",
      content: [
        { type: "text", text: "1. Edit source.ts\nDo not modify files." },
      ],
      stopReason: "stop",
      timestamp: 2,
    } as AgentMessage);
    await extension.input("Implement JIRA-123 now");
    const output = await extension.project([
      { role: "user", content: "Implement JIRA-123 now", timestamp: 3 },
    ]);
    expect(JSON.stringify(output?.messages[0])).not.toContain(
      "Do not modify files.",
    );
    expect(JSON.stringify(output?.messages[0])).toContain("1. Edit source.ts");
    const lastAudit = extension.entries.at(-1)?.data;
    expect(lastAudit).toBeDefined();
    expect((lastAudit as any).invariantViolations).toContainEqual({
      rule: "stale-plan-directive",
      detail: "Do not modify files.",
    });
  });

  test("an unrelated task excludes earlier task messages", () => {
    const messages = [
      { role: "user", content: "first task", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        stopReason: "stop",
        timestamp: 2,
      },
      { role: "user", content: "second task", timestamp: 3 },
    ] as AgentMessage[];
    expect(scopeMessagesToGoal(messages, "second task")).toEqual([messages[2]]);
  });

  test("an interrupted planning turn is not promoted as a plan", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Create a plan for JIRA-456");
    await extension.turnEnd({
      role: "assistant",
      content: [{ type: "text", text: "1. Incomplete draft" }],
      stopReason: "aborted",
      timestamp: 2,
    } as AgentMessage);
    await extension.input("Implement JIRA-456 now");
    const output = await extension.project([
      { role: "user", content: "Implement JIRA-456 now", timestamp: 3 },
    ]);
    expect(JSON.stringify(output?.messages[0])).not.toContain("PINNED PLAN");
  });

  test("tree reconstruction restores the selected branch plan state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-tree-"));
    try {
      const extension = harness(cwd);
      await extension.start();
      await extension.input("Create a plan for JIRA-789");
      await extension.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "1. Inspect\n2. Implement" }],
        stopReason: "stop",
        timestamp: 2,
      } as AgentMessage);
      const planningBranch = extension.branch();

      await extension.input("Implement JIRA-789 now");
      let output = await extension.project([
        { role: "user", content: "Implement JIRA-789 now", timestamp: 3 },
      ]);
      expect(JSON.stringify(output?.messages[0])).toContain(
        "TASK ID: JIRA-789",
      );
      expect(JSON.stringify(output?.messages[0])).toContain(
        "PINNED PLAN (revision 1)",
      );

      extension.replaceBranch(planningBranch);
      await extension.tree();
      await extension.input("Implement JIRA-789 after tree navigation");
      output = await extension.project([
        {
          role: "user",
          content: "Implement JIRA-789 after tree navigation",
          timestamp: 4,
        },
      ]);
      expect(JSON.stringify(output?.messages[0])).toContain(
        "PINNED PLAN (revision 1)",
      );
      expect(JSON.stringify(output?.messages[0])).toContain(
        "1. Inspect\\n  2. Implement",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a short affirmative reply does not reset the task anchor", async () => {
    const extension = harness();
    await extension.start();
    await extension.input(
      "how do we maintain tools from users if the tool is a cli tool?",
    );
    await extension.turnEnd({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Your options: 1. Agent-side proxy (recommended) - the sidecar pattern.",
        },
      ],
      stopReason: "stop",
      timestamp: 2,
    } as AgentMessage);
    const anchorEntriesBefore = extension.entries.filter(
      (entry) => entry.customType === ANCHOR_ENTRY_TYPE,
    ).length;

    await extension.input("yes proceed with option 1");

    const anchorEntriesAfter = extension.entries.filter(
      (entry) => entry.customType === ANCHOR_ENTRY_TYPE,
    );
    expect(anchorEntriesAfter.length).toBe(anchorEntriesBefore);
    const output = await extension.project([
      {
        role: "user",
        content:
          "how do we maintain tools from users if the tool is a cli tool?",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Your options: 1. Agent-side proxy (recommended) - the sidecar pattern.",
          },
        ],
        stopReason: "stop",
        timestamp: 2,
      },
      { role: "user", content: "yes proceed with option 1", timestamp: 3 },
    ] as AgentMessage[]);
    expect(JSON.stringify(output?.messages)).toContain(
      "how do we maintain tools",
    );
  });

  test("resumes the pinned plan across a process restart on the same session ID", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-pi-"));
    const cardsDir = await mkdtemp(path.join(tmpdir(), "context-card-cards-"));
    const previousEnv = process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
    process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = cardsDir;
    try {
      const first = harness(cwd, { sessionId: "session-restart" });
      await first.start();
      await first.input("Create a plan for JIRA-123");
      await first.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "1. Inspect\n2. Implement" }],
        stopReason: "stop",
        timestamp: 2,
      } as AgentMessage);
      await first.input("Implement JIRA-123 now");
      await first.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "Working on it." }],
        stopReason: "stop",
        timestamp: 3,
      } as AgentMessage);

      // A brand-new harness instance with an empty branch, same session ID:
      // simulates the Pi process restarting mid-session.
      const second = harness(cwd, { sessionId: "session-restart" });
      second.setFlag("context-card-plan-framing", "scope-note");
      await second.start();
      const output = await second.project([
        { role: "user", content: "continue", timestamp: 4 },
      ]);
      expect(JSON.stringify(output?.messages[0])).toContain(
        "TASK ID: JIRA-123",
      );
      expect(JSON.stringify(output?.messages[0])).toContain(
        "PINNED PLAN (revision 1)",
      );
      expect(JSON.stringify(output?.messages[0])).toContain(
        "1. Inspect\\n  2. Implement",
      );
    } finally {
      if (previousEnv === undefined)
        delete process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
      else process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = previousEnv;
      await rm(cwd, { recursive: true, force: true });
      await rm(cardsDir, { recursive: true, force: true });
    }
  });

  test("never persists or resumes anything without a session ID", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-pi-nosid-"));
    const cardsDir = await mkdtemp(
      path.join(tmpdir(), "context-card-cards-nosid-"),
    );
    const previousEnv = process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
    process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = cardsDir;
    try {
      const first = harness(cwd);
      await first.start();
      await first.input("Refactor the payment module");
      await first.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "Refactored." }],
        stopReason: "stop",
        timestamp: 2,
      } as AgentMessage);

      const second = harness(cwd);
      await second.start();
      const output = await second.project([
        { role: "user", content: "continue", timestamp: 3 },
      ]);
      expect(JSON.stringify(output?.messages[0])).not.toContain(
        "Refactor the payment module",
      );
    } finally {
      if (previousEnv === undefined)
        delete process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
      else process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = previousEnv;
      await rm(cwd, { recursive: true, force: true });
      await rm(cardsDir, { recursive: true, force: true });
    }
  });

  test("a session with no typed ticket ID still persists and recovers on the same session ID", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-pi-nl-"));
    const cardsDir = await mkdtemp(
      path.join(tmpdir(), "context-card-cards-nl-"),
    );
    const previousEnv = process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
    process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = cardsDir;
    try {
      const first = harness(cwd, { sessionId: "session-nl" });
      await first.start();
      await first.input("Refactor the payment module");
      await first.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "Refactored." }],
        stopReason: "stop",
        timestamp: 2,
      } as AgentMessage);

      const second = harness(cwd, { sessionId: "session-nl" });
      await second.start();
      const output = await second.project([
        { role: "user", content: "continue", timestamp: 3 },
      ]);
      expect(JSON.stringify(output?.messages[0])).toContain(
        "Refactor the payment module",
      );

      const other = harness(cwd, { sessionId: "session-other" });
      await other.start();
      const otherOutput = await other.project([
        { role: "user", content: "continue", timestamp: 3 },
      ]);
      expect(JSON.stringify(otherOutput?.messages[0])).not.toContain(
        "Refactor the payment module",
      );
    } finally {
      if (previousEnv === undefined)
        delete process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
      else process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = previousEnv;
      await rm(cwd, { recursive: true, force: true });
      await rm(cardsDir, { recursive: true, force: true });
    }
  });

  test("update_card persists CardState and survives a simulated restart", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-state-"));
    const cardsDir = await mkdtemp(
      path.join(tmpdir(), "context-card-state-cards-"),
    );
    const previousEnv = process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
    process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = cardsDir;
    try {
      const first = harness(cwd, { sessionId: "session-state" });
      await first.start();
      await first.input("Implement the card feature");
      await first.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "Working on it." }],
        stopReason: "stop",
        timestamp: 2,
      } as AgentMessage);
      const tool = first.tools.find((t) => t.name === "update_card");
      expect(tool).toBeDefined();
      if (!tool) throw new Error("update_card tool missing");
      const updated = await tool.execute(
        "call-1",
        {
          pending: ["verify rebuild"],
          findings: [{ topic: "schema", detail: "no caps allowed" }],
        },
        undefined,
        undefined,
        {} as any,
      );
      expect((updated as any).content[0].text).toBe("Card updated.");
      await first.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
        timestamp: 3,
      } as AgentMessage);

      // Brand-new harness with an empty branch, same session ID: simulates
      // a Pi process restart mid-session. The card must come back via
      // SessionCardStore, not by re-persisting fresh state.
      const second = harness(cwd, { sessionId: "session-state" });
      await second.start();
      const restored = second.tools.find((t) => t.name === "update_card");
      expect(restored).toBeDefined();
      const readState = async () => {
        const noop = await restored!.execute(
          "probe",
          {},
          undefined,
          undefined,
          {} as any,
        );
        expect((noop as any).content[0].text).toBe("Card updated.");
        const secondStateEntries = second.entries.filter(
          (entry) => entry.customType === CARD_STATE_ENTRY_TYPE,
        );
        return (secondStateEntries.at(-1)?.data as any)?.state;
      };
      const restoredState = await readState();
      expect(restoredState).toEqual({
        pending: ["verify rebuild"],
        findings: [{ topic: "schema", detail: "no caps allowed" }],
      });
      // Confirm a subsequent explicit update still wins over the restored state.
      await restored!.execute(
        "call-2",
        {
          pending: ["verify rebuild", "rerun smoke"],
          findings: [{ topic: "schema", detail: "restored after restart" }],
        },
        undefined,
        undefined,
        {} as any,
      );
      const secondStateEntries = second.entries.filter(
        (entry) => entry.customType === CARD_STATE_ENTRY_TYPE,
      );
      expect((secondStateEntries.at(-1)?.data as any)?.state).toEqual({
        pending: ["verify rebuild", "rerun smoke"],
        findings: [{ topic: "schema", detail: "restored after restart" }],
      });
    } finally {
      if (previousEnv === undefined)
        delete process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
      else process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = previousEnv;
      await rm(cwd, { recursive: true, force: true });
      await rm(cardsDir, { recursive: true, force: true });
    }
  });

  test("turn_end nudges once activity exceeds the threshold without update_card", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    for (let index = 0; index < 11; index += 1) {
      await extension.toolExecutionEnd({
        toolName: "read",
        isError: false,
      });
    }
    await extension.turnEnd({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      timestamp: 9,
    } as AgentMessage);
    const nudges = extension.sentMessages.filter(
      (entry) => entry.message.customType === CARD_NUDGE_MESSAGE_TYPE,
    );
    expect(nudges.length).toBe(1);
    expect(nudges[0]?.options).toEqual({
      deliverAs: "steer",
      triggerTurn: true,
    });
  });

  test("before_provider_request returns a payload forcing update_card once activity exceeds the threshold", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    for (let index = 0; index < 11; index += 1) {
      await extension.toolExecutionEnd({ toolName: "read", isError: false });
    }
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [
        { type: "function", function: { name: "update_card" } },
        { type: "function", function: { name: "read" } },
      ],
    };
    const result = await extension.beforeProviderRequest(payload);
    expect(result).toBeDefined();
    expect((result as any).tool_choice).toEqual({
      type: "function",
      function: { name: "update_card" },
    });
  });

  test("before_provider_request does not force tool_choice below the activity threshold", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    await extension.toolExecutionEnd({ toolName: "read", isError: false });
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "update_card" } }],
    };
    const result = await extension.beforeProviderRequest(payload);
    expect(result).toBeUndefined();
  });

  test("before_provider_request stops forcing after its own cap, independent of the nudge streak", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    for (let index = 0; index < 11; index += 1) {
      await extension.toolExecutionEnd({ toolName: "read", isError: false });
    }
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "update_card" } }],
    };
    const first = await extension.beforeProviderRequest(payload);
    const second = await extension.beforeProviderRequest(payload);
    const third = await extension.beforeProviderRequest(payload);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeUndefined();
  });

  test("a single costly read forces update_card without waiting for the activity threshold", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    // One read, but a large one - should push straight past the generic
    // activity threshold rather than needing ten more reads first.
    await extension.toolExecutionEnd({
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "x".repeat(5000) }] },
    });
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "update_card" } }],
    };
    const result = await extension.beforeProviderRequest(payload);
    expect(result).toBeDefined();
    expect((result as any).tool_choice).toEqual({
      type: "function",
      function: { name: "update_card" },
    });
  });

  test("a single small read does not force update_card", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    await extension.toolExecutionEnd({
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "small file" }] },
    });
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "update_card" } }],
    };
    const result = await extension.beforeProviderRequest(payload);
    expect(result).toBeUndefined();
  });

  test("a thin response to a forced update_card does not reset the activity streak", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    for (let index = 0; index < 11; index += 1) {
      await extension.toolExecutionEnd({ toolName: "read", isError: false });
    }
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "update_card" } }],
    };
    const forced = await extension.beforeProviderRequest(payload);
    expect(forced).toBeDefined();

    const tool = extension.tools.find((t) => t.name === "update_card");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("update_card tool missing");
    // Responds to the force with nothing - no pending, no findings.
    await tool.execute("call-1", {}, undefined, undefined, {} as any);

    // Activity never reset, so a single further read keeps it above the
    // threshold and forcing should engage again immediately.
    await extension.toolExecutionEnd({ toolName: "read", isError: false });
    const forcedAgain = await extension.beforeProviderRequest(payload);
    expect(forcedAgain).toBeDefined();
  });

  test("a real response to a forced update_card resets the activity streak", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    for (let index = 0; index < 11; index += 1) {
      await extension.toolExecutionEnd({ toolName: "read", isError: false });
    }
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "update_card" } }],
    };
    const forced = await extension.beforeProviderRequest(payload);
    expect(forced).toBeDefined();

    const tool = extension.tools.find((t) => t.name === "update_card");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("update_card tool missing");
    await tool.execute(
      "call-1",
      { findings: [{ topic: "schema", detail: "no caps allowed" }] },
      undefined,
      undefined,
      {} as any,
    );

    // Activity reset to 0, so a single further read stays well below the
    // threshold and forcing should not engage again yet.
    await extension.toolExecutionEnd({ toolName: "read", isError: false });
    const notForcedYet = await extension.beforeProviderRequest(payload);
    expect(notForcedYet).toBeUndefined();
  });

  test("before_agent_start appends an unattended-session note when no UI is available", async () => {
    const extension = harness(process.cwd(), { hasUI: false });
    await extension.start();
    const result = await extension.beforeAgentStart("Base system prompt.");
    expect(result).toBeDefined();
    expect(result?.systemPrompt).toContain("Base system prompt.");
    expect(result?.systemPrompt).toContain("running unattended");
  });

  test("before_agent_start leaves the system prompt untouched when a UI is available", async () => {
    const extension = harness(process.cwd(), { hasUI: true });
    await extension.start();
    const result = await extension.beforeAgentStart("Base system prompt.");
    expect(result).toBeUndefined();
  });

  test("the exact same call failing twice in a row triggers a repeated-call steer nudge", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    await extension.call(
      "call-1",
      "read",
      { path: "sympy/solveset.py" },
      { isError: true },
    );
    let nudges = extension.sentMessages.filter(
      (entry) =>
        entry.message.customType === CARD_NUDGE_MESSAGE_TYPE &&
        entry.options?.deliverAs === "steer",
    );
    expect(nudges.length).toBe(0);

    await extension.call(
      "call-2",
      "read",
      { path: "sympy/solveset.py" },
      { isError: true },
    );
    nudges = extension.sentMessages.filter(
      (entry) =>
        entry.message.customType === CARD_NUDGE_MESSAGE_TYPE &&
        entry.options?.deliverAs === "steer",
    );
    expect(nudges.length).toBe(1);
  });

  test("a different failing call does not count toward the repeated-call streak", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    await extension.call(
      "call-1",
      "read",
      { path: "sympy/solveset.py" },
      { isError: true },
    );
    await extension.call(
      "call-2",
      "read",
      { path: "sympy/other.py" },
      { isError: true },
    );
    const nudges = extension.sentMessages.filter(
      (entry) =>
        entry.message.customType === CARD_NUDGE_MESSAGE_TYPE &&
        entry.options?.deliverAs === "steer",
    );
    expect(nudges.length).toBe(0);
  });

  test("a successful call in between resets the repeated-failure streak", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    await extension.call(
      "call-1",
      "read",
      { path: "sympy/solveset.py" },
      { isError: true },
    );
    await extension.call("call-2", "bash", { command: "ls" }, {});
    await extension.call(
      "call-3",
      "read",
      { path: "sympy/solveset.py" },
      { isError: true },
    );
    const nudges = extension.sentMessages.filter(
      (entry) =>
        entry.message.customType === CARD_NUDGE_MESSAGE_TYPE &&
        entry.options?.deliverAs === "steer",
    );
    expect(nudges.length).toBe(0);
  });

  test("repeated-call nudging caps at two, matching the other nudge streak cap", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    for (let index = 0; index < 5; index += 1) {
      await extension.call(
        `call-${index}`,
        "read",
        { path: "sympy/solveset.py" },
        { isError: true },
      );
    }
    const nudges = extension.sentMessages.filter(
      (entry) =>
        entry.message.customType === CARD_NUDGE_MESSAGE_TYPE &&
        entry.options?.deliverAs === "steer",
    );
    expect(nudges.length).toBe(2);
  });

  test("a forced update_card call steers the model back to acting, whether thin or substantive", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    for (let index = 0; index < 11; index += 1) {
      await extension.toolExecutionEnd({ toolName: "read", isError: false });
    }
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "update_card" } }],
    };
    const forced = await extension.beforeProviderRequest(payload);
    expect(forced).toBeDefined();

    const tool = extension.tools.find((t) => t.name === "update_card");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("update_card tool missing");
    // Thin forced response: tool_choice compelled the call, but there's
    // nothing substantive in it - the model was still cut off mid-task and
    // still needs steering back to acting, not just its own next free turn.
    await tool.execute("call-1", {}, undefined, undefined, {} as any);

    const steerCalls = extension.sentMessages.filter(
      (entry) =>
        entry.message.customType === CARD_NUDGE_MESSAGE_TYPE &&
        entry.options?.deliverAs === "steer",
    );
    expect(steerCalls.length).toBe(1);
  });

  test("a forced substantive update_card call also steers the model back to acting", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    for (let index = 0; index < 11; index += 1) {
      await extension.toolExecutionEnd({ toolName: "read", isError: false });
    }
    const payload = {
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "update_card" } }],
    };
    const forced = await extension.beforeProviderRequest(payload);
    expect(forced).toBeDefined();

    const tool = extension.tools.find((t) => t.name === "update_card");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("update_card tool missing");
    // Substantive forced response - the trace this fix was built from had
    // exactly this shape (real content, forced call) and the model still
    // stopped afterward instead of executing its own stated plan.
    await tool.execute(
      "call-1",
      { findings: [{ topic: "schema", detail: "no caps allowed" }] },
      undefined,
      undefined,
      {} as any,
    );

    const steerCalls = extension.sentMessages.filter(
      (entry) =>
        entry.message.customType === CARD_NUDGE_MESSAGE_TYPE &&
        entry.options?.deliverAs === "steer",
    );
    expect(steerCalls.length).toBe(1);
  });

  test("a voluntary (non-forced) update_card call does not send the extra steer nudge", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature X");
    const tool = extension.tools.find((t) => t.name === "update_card");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("update_card tool missing");
    await tool.execute(
      "call-1",
      { findings: [{ topic: "schema", detail: "no caps allowed" }] },
      undefined,
      undefined,
      {} as any,
    );

    const steerCalls = extension.sentMessages.filter(
      (entry) =>
        entry.message.customType === CARD_NUDGE_MESSAGE_TYPE &&
        entry.options?.deliverAs === "steer",
    );
    expect(steerCalls.length).toBe(0);
  });

  test("nudging stops after two consecutive misses rather than continuing forever", async () => {
    const extension = harness();
    await extension.start();
    await extension.input("Implement feature Y");
    for (let cycle = 0; cycle < 4; cycle += 1) {
      for (let index = 0; index < 11; index += 1) {
        await extension.toolExecutionEnd({
          toolName: "read",
          isError: false,
        });
      }
      await extension.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "still going" }],
        stopReason: "stop",
        timestamp: 10 + cycle,
      } as AgentMessage);
    }
    const nudges = extension.sentMessages.filter(
      (entry) => entry.message.customType === CARD_NUDGE_MESSAGE_TYPE,
    );
    expect(nudges.length).toBe(2);
    const auditSkips = extension.entries.filter(
      (entry) =>
        entry.customType === TASK_STATE_AUDIT_ENTRY_TYPE &&
        (entry.data as any)?.status === "skipped",
    );
    expect(auditSkips.length).toBeGreaterThan(0);
  });

  test("update_card pending/findings reach the rendered card every turn", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-pend-"));
    const cardsDir = await mkdtemp(
      path.join(tmpdir(), "context-card-pend-cards-"),
    );
    const previousEnv = process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
    process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = cardsDir;
    try {
      const extension = harness(cwd, { sessionId: "session-pend" });
      await extension.start();
      await extension.input("Implement the card feature");
      await extension.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "Working on it." }],
        stopReason: "stop",
        timestamp: 2,
      } as AgentMessage);
      const tool = extension.tools.find((t) => t.name === "update_card");
      expect(tool).toBeDefined();
      if (!tool) throw new Error("update_card tool missing");
      await tool.execute(
        "call-1",
        {
          pending: ["verify rebuild", "rerun smoke"],
          findings: [
            { topic: "schema", detail: "no caps allowed" },
            { topic: "scope", detail: "repo always present" },
          ],
        },
        undefined,
        undefined,
        {} as any,
      );

      const output = await extension.project([
        {
          role: "user",
          content: "Implement the card feature",
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Working on it." }],
          stopReason: "stop",
          timestamp: 2,
        },
      ] as AgentMessage[]);
      // Pending/findings are volatile, so they render in the trailing
      // status message, not the leading (cacheable) card message.
      const status = JSON.stringify(output?.messages.at(-1));
      expect(status).toContain("what's pending: verify rebuild; rerun smoke");
      expect(status).toContain(
        "findings: schema: no caps allowed; scope: repo always present",
      );
    } finally {
      if (previousEnv === undefined)
        delete process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
      else process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = previousEnv;
      await rm(cwd, { recursive: true, force: true });
      await rm(cardsDir, { recursive: true, force: true });
    }
  });

  test("repo appears in the rendered card every turn, even before resuming a prior session", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-repo-"));
    const cardsDir = await mkdtemp(
      path.join(tmpdir(), "context-card-repo-cards-"),
    );
    const previousEnv = process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
    process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = cardsDir;
    try {
      const extension = harness(cwd, { sessionId: "session-repo" });
      await extension.start();
      await extension.input("Inspect the project");
      const output = await extension.project([
        { role: "user", content: "Inspect the project", timestamp: 1 },
      ] as AgentMessage[]);
      const card = JSON.stringify(output?.messages[0]);
      expect(card).toMatch(/repo:\s+/);
    } finally {
      if (previousEnv === undefined)
        delete process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
      else process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = previousEnv;
      await rm(cwd, { recursive: true, force: true });
      await rm(cardsDir, { recursive: true, force: true });
    }
  });

  test("filesRead reaches the rendered card as a flat line when present", async () => {
    // A bare read with no later mutation stays "active" — and active
    // entries are now omitted from the card entirely, since their content
    // is already visible in the projected transcript. To exercise the
    // rendered "files read:" line, follow the read with a write to the
    // same path so the lease becomes "consumed".
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-files-"));
    const cardsDir = await mkdtemp(
      path.join(tmpdir(), "context-card-files-cards-"),
    );
    const previousEnv = process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
    process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = cardsDir;
    try {
      const extension = harness(cwd, { sessionId: "session-files" });
      await extension.start();
      await extension.input("Read src/a.ts");
      const readId = "read-1";
      const writeId = "write-1";
      await extension.turnEnd({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: readId,
            name: "read",
            arguments: { path: "src/a.ts" },
          },
        ],
        stopReason: "toolUse",
        timestamp: 2,
      } as unknown as AgentMessage);
      await extension.toolExecutionEnd({
        toolName: "read",
        isError: false,
        result: { content: [{ type: "text", text: "v1" }] },
      });
      await extension.turnEnd({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: writeId,
            name: "write",
            arguments: { path: "src/a.ts", content: "v2" },
          },
        ],
        stopReason: "toolUse",
        timestamp: 4,
      } as unknown as AgentMessage);
      await extension.toolExecutionEnd({
        toolName: "write",
        isError: false,
        result: { content: [{ type: "text", text: "ok" }] },
      });
      await extension.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "read then wrote a.ts" }],
        stopReason: "stop",
        timestamp: 6,
      } as AgentMessage);
      const output = await extension.project([
        { role: "user", content: "Read src/a.ts", timestamp: 1 },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: readId,
              name: "read",
              arguments: { path: "src/a.ts" },
            },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: readId,
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "v1" }],
          timestamp: 3,
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: writeId,
              name: "write",
              arguments: { path: "src/a.ts", content: "v2" },
            },
          ],
          stopReason: "toolUse",
          timestamp: 4,
        },
        {
          role: "toolResult",
          toolCallId: writeId,
          toolName: "write",
          isError: false,
          content: [{ type: "text", text: "ok" }],
          timestamp: 5,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "read then wrote a.ts" }],
          stopReason: "stop",
          timestamp: 6,
        },
      ] as AgentMessage[]);
      // filesRead is volatile, so it renders in the trailing status
      // message, not the leading (cacheable) card message.
      const status = JSON.stringify(output?.messages.at(-1));
      // The read is now consumed by the later write on the same path, so
      // it's the one case where the card is expected to mention it.
      expect(status).toMatch(/files read: .+ \(consumed\)/);
    } finally {
      if (previousEnv === undefined)
        delete process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
      else process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = previousEnv;
      await rm(cwd, { recursive: true, force: true });
      await rm(cardsDir, { recursive: true, force: true });
    }
  });

  test("rendered card omits empty fields entirely", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-empty-"));
    const cardsDir = await mkdtemp(
      path.join(tmpdir(), "context-card-empty-cards-"),
    );
    const previousEnv = process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
    process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = cardsDir;
    try {
      const extension = harness(cwd, { sessionId: "session-empty" });
      await extension.start();
      await extension.input("Inspect the project");
      const output = await extension.project([
        { role: "user", content: "Inspect the project", timestamp: 1 },
      ] as AgentMessage[]);
      const card = JSON.stringify(output?.messages[0]);
      expect(card).not.toContain("what happened:");
      expect(card).not.toContain("what's pending:");
      expect(card).not.toContain("findings:");
      expect(card).not.toContain("files read:");
      expect(card).not.toContain("failures:");
    } finally {
      if (previousEnv === undefined)
        delete process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR;
      else process.env.AGENT_CONTEXT_CARD_TEST_CARDS_DIR = previousEnv;
      await rm(cwd, { recursive: true, force: true });
      await rm(cardsDir, { recursive: true, force: true });
    }
  });
});
