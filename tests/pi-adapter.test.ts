import { describe, expect, test } from "bun:test";
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

function harness() {
  const flags = new Map<string, string | boolean>();
  const handlers = new Map<string, Handler[]>();
  const tools: ToolDefinition[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    registerFlag(name: string, options: { default?: string | boolean }) {
      if (options.default !== undefined) flags.set(name, options.default);
    },
    getFlag: (name: string) => flags.get(name),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand() {},
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ customType, data }),
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  agentContextCard(pi);
  const context = {
    cwd: process.cwd(),
    sessionManager: { getBranch: () => [] },
    model: { provider: "test", id: "model", contextWindow: 128_000 },
    ui: { setStatus() {}, notify() {} },
  } as unknown as ExtensionContext;
  return {
    tools,
    entries,
    async start() {
      for (const handler of handlers.get("session_start") ?? [])
        await handler({}, context);
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
});
