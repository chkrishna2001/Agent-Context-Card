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
import { AUDIT_ENTRY_TYPE, CARD_MESSAGE_TYPE } from "../src/core/types";
import { scopeMessagesToGoal } from "../src/pi/normalize";

type Handler = (...args: any[]) => any;

function harness(cwd = process.cwd()) {
  const flags = new Map<string, string | boolean>();
  const handlers = new Map<string, Handler[]>();
  const tools: ToolDefinition[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
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
  } as unknown as ExtensionAPI;
  agentContextCard(pi);
  const context = {
    cwd,
    sessionManager: { getBranch: () => branch },
    model: { provider: "test", id: "model", contextWindow: 128_000 },
    ui: { setStatus() {}, notify() {} },
  } as unknown as ExtensionContext;
  return {
    tools,
    entries,
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
    async turnEnd(message: AgentMessage) {
      branch.push({ type: "message", message });
      for (const handler of handlers.get("turn_end") ?? [])
        await handler({ message, toolResults: [] }, context);
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
  test("registers no model-facing tools and keeps audit outside context", async () => {
    const extension = harness();
    await extension.start();
    const output = await extension.project([
      { role: "user", content: "Inspect the project", timestamp: 1 },
    ]);
    expect(extension.tools).toEqual([]);
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

  test("automatically resumes an exact plan without a maintenance command", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-pi-"));
    try {
      const first = harness(cwd);
      await first.start();
      await first.input("Create a plan for JIRA-123");
      await first.turnEnd({
        role: "assistant",
        content: [{ type: "text", text: "1. Inspect\n2. Implement" }],
        stopReason: "stop",
        timestamp: 2,
      } as AgentMessage);

      const second = harness(cwd);
      second.setFlag("context-card-plan-framing", "scope-note");
      await second.start();
      await second.input("Implement JIRA-123 now");
      const output = await second.project([
        { role: "user", content: "Implement JIRA-123 now", timestamp: 3 },
      ]);
      expect(JSON.stringify(output?.messages[0])).toContain(
        "TASK ID: JIRA-123",
      );
      expect(JSON.stringify(output?.messages[0])).toContain(
        "PINNED PLAN (revision 1)",
      );
      expect(JSON.stringify(output?.messages[0])).toContain(
        "The current request is post-planning",
      );
      expect(
        (second.entries.at(-1)?.data as any).continuity.planPhaseFramingState,
      ).toBe("post-planning");
      expect(JSON.stringify(output?.messages[0])).toContain(
        "1. Inspect\\n  2. Implement",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
