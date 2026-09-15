#!/usr/bin/env node
// Reads one or more Pi session .jsonl files and prints a plain-language
// report of what agent-context-card actually did in them - tool-call
// tallies, task-state-audit events (blocks, cache hits, forced updates),
// and read hotspots (a path read enough times to be worth a second look).
//
// Built directly from today's investigation: every finding in
// docs/notes/hard-block-reflection-escalation-2026-09-14.md started as a
// hand-written DuckDB query against a raw session log. This automates that
// so the next investigation starts from a report, not from scratch.
//
// Usage:
//   node scripts/evaluation/session-doctor.mjs <session.jsonl> [more.jsonl ...]
//   node scripts/evaluation/session-doctor.mjs --json <session.jsonl>
//   node scripts/evaluation/session-doctor.mjs --last [n]   # n most recent, default 1
//   node scripts/evaluation/session-doctor.mjs --list [n]   # just list candidates, don't analyze

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseJsonLines } from "./metrics.mjs";

// Every location a Pi session .jsonl can plausibly end up: real interactive/
// print-mode usage (Pi hashes the cwd into a folder name under here, one
// folder per project worked in - not reproduced here, just searched
// recursively) and this repo's own evaluation harness output. Real session
// IDs are UUIDs nobody has memorized, which is the whole reason --last and
// --list exist.
function defaultSearchRoots() {
  return [
    path.join(homedir(), ".pi", "agent", "sessions"),
    path.join(process.cwd(), ".agent-context-card", "e"),
  ];
}

// The evaluation harness (scripts/evaluation/run.mjs) writes two different
// .jsonl formats per run: `t/*.jsonl` is the raw Pi event stream (trace),
// `s/*.jsonl` is the actual persisted session log this tool understands
// (type: "message" / "custom" records). Both start with an identical
// {"type":"session",...} header line, so they can't be told apart by
// sniffing content cheaply - excluding any path through a `t` directory
// (the harness's own naming convention) is the reliable, cheap filter.
function isTraceFile(filePath) {
  return filePath.split(path.sep).includes("t");
}

async function findSessionFiles(root) {
  const found = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = path.join(entry.parentPath ?? entry.path ?? root, entry.name);
    if (isTraceFile(path.relative(root, full))) continue;
    found.push(full);
  }
  return found;
}

async function recentSessionFiles(limit) {
  const roots = defaultSearchRoots();
  const files = (await Promise.all(roots.map(findSessionFiles))).flat();
  const withStats = await Promise.all(
    files.map(async (file) => {
      try {
        const info = await stat(file);
        return { file, mtimeMs: info.mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  return withStats
    .filter((entry) => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

const READ_HOTSPOT_THRESHOLD = 3;

function fileTarget(args = {}) {
  const value = args?.path ?? args?.filePath ?? args?.file_path;
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function toolCallsIn(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part?.type === "toolCall");
}

// Session records only carry message role/content, not the tool_call/
// tool_execution_* event stream a trace file has - toolResult messages
// don't echo the tool name, so pair each result back to its call by index
// to know which tool it belongs to.
function analyze(records) {
  const toolCallTally = new Map();
  const readsByPath = new Map();
  const taskStateEvents = [];
  const taskStateTally = new Map();
  const timestamps = [];
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResultMessages = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;

  const pendingCallNames = [];

  for (const entry of records) {
    if (entry.timestamp) timestamps.push(entry.timestamp);
    if (
      entry.type === "custom" &&
      entry.customType?.endsWith("task-state-audit")
    ) {
      const data = entry.data ?? {};
      taskStateEvents.push({
        timestamp: entry.timestamp,
        operation: data.operation,
        status: data.status,
        detail: data.detail,
      });
      const key = `${data.operation ?? "unknown"}:${data.status ?? "unknown"}`;
      taskStateTally.set(key, (taskStateTally.get(key) ?? 0) + 1);
      continue;
    }
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "user") userMessages++;
    if (role === "assistant") {
      assistantMessages++;
      for (const call of toolCallsIn(entry.message.content)) {
        toolCallCount++;
        const name = call.name ?? "unknown";
        toolCallTally.set(name, (toolCallTally.get(name) ?? 0) + 1);
        pendingCallNames.push(name);
        if (name === "read" || name === "view_file") {
          const target = fileTarget(call.arguments);
          if (target) {
            const list = readsByPath.get(target) ?? [];
            list.push({
              offset: call.arguments?.offset,
              limit: call.arguments?.limit,
              timestamp: entry.timestamp,
            });
            readsByPath.set(target, list);
          }
        }
      }
    }
    if (role === "toolResult") {
      toolResultMessages++;
      pendingCallNames.shift();
      if (entry.message.isError) toolErrorCount++;
    }
  }

  return {
    userMessages,
    assistantMessages,
    toolResultMessages,
    toolCallCount,
    toolErrorCount,
    toolCallTally,
    readsByPath,
    taskStateEvents,
    taskStateTally,
    firstTimestamp: timestamps[0],
    lastTimestamp: timestamps[timestamps.length - 1],
  };
}

function formatTally(tally) {
  return [...tally.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `  ${name}: ${count}`)
    .join("\n");
}

function report(filePath, analysis) {
  const lines = [];
  lines.push(`\n${"=".repeat(72)}`);
  lines.push(filePath);
  lines.push("=".repeat(72));

  if (analysis.firstTimestamp && analysis.lastTimestamp) {
    const durationMs =
      new Date(analysis.lastTimestamp).getTime() -
      new Date(analysis.firstTimestamp).getTime();
    lines.push(
      `Span: ${analysis.firstTimestamp} -> ${analysis.lastTimestamp} (${(durationMs / 1000).toFixed(1)}s)`,
    );
  }
  lines.push(
    `Messages: user=${analysis.userMessages} assistant=${analysis.assistantMessages} toolResult=${analysis.toolResultMessages}`,
  );
  lines.push(
    `Tool calls: ${analysis.toolCallCount} (${analysis.toolErrorCount} errors)`,
  );

  lines.push("\nTool calls by name:");
  lines.push(formatTally(analysis.toolCallTally) || "  (none)");

  lines.push("\nTask-state audit events by operation:status:");
  lines.push(formatTally(analysis.taskStateTally) || "  (none)");

  const blockOrCacheEvents = analysis.taskStateEvents.filter((event) =>
    ["forcing", "cache"].includes(event.operation),
  );
  if (blockOrCacheEvents.length > 0) {
    lines.push(
      `\nRepeat/block activity (${blockOrCacheEvents.length} event(s)):`,
    );
    for (const event of blockOrCacheEvents) {
      lines.push(
        `  [${event.timestamp}] ${event.operation}: ${event.detail ?? ""}`,
      );
    }
  }

  const hotspots = [...analysis.readsByPath.entries()]
    .filter(([, reads]) => reads.length >= READ_HOTSPOT_THRESHOLD)
    .sort(([, a], [, b]) => b.length - a.length);
  if (hotspots.length > 0) {
    lines.push(
      `\n⚠ Read hotspots (path read ${READ_HOTSPOT_THRESHOLD}+ times - worth checking for redundant windowed reads):`,
    );
    for (const [target, reads] of hotspots) {
      const windows = reads
        .map((read) => `${read.offset ?? 1}+${read.limit ?? "all"}`)
        .join(", ");
      lines.push(`  ${target}: ${reads.length} reads [${windows}]`);
    }
  } else {
    lines.push("\nNo read hotspots (nothing read 3+ times).");
  }

  return lines.join("\n");
}

function parseArgs(argv) {
  const flags = { json: false, last: undefined, list: undefined };
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--last" || arg === "--list") {
      const key = arg.slice(2);
      const next = argv[index + 1];
      const explicit = next && /^\d+$/.test(next);
      if (explicit) index++;
      flags[key] = explicit ? Number(next) : key === "list" ? 10 : 1;
      continue;
    }
    if (!arg.startsWith("--")) files.push(arg);
  }
  return { flags, files };
}

async function main() {
  const { flags, files: explicitFiles } = parseArgs(process.argv.slice(2));
  const asJson = flags.json;

  if (flags.list !== undefined) {
    const candidates = await recentSessionFiles(flags.list);
    if (candidates.length === 0) {
      console.log(
        "No session .jsonl files found under the default search roots.",
      );
      return;
    }
    console.log(`Most recent ${candidates.length} session file(s):\n`);
    for (const { file, mtimeMs } of candidates)
      console.log(`  ${new Date(mtimeMs).toISOString()}  ${file}`);
    return;
  }

  let files = explicitFiles;
  if (flags.last !== undefined) {
    const candidates = await recentSessionFiles(flags.last);
    files = candidates.map((entry) => entry.file);
    if (files.length === 0) {
      throw new Error(
        "No session .jsonl files found under the default search roots (~/.pi/agent/sessions, .agent-context-card/e).",
      );
    }
  }

  if (files.length === 0) {
    throw new Error(
      "Usage: node scripts/evaluation/session-doctor.mjs [--json] <session.jsonl> [more.jsonl ...]\n" +
        "   or: node scripts/evaluation/session-doctor.mjs --last [n]   (n most recent, default 1)\n" +
        "   or: node scripts/evaluation/session-doctor.mjs --list [n]   (list candidates, default 10)",
    );
  }

  const results = [];
  for (const file of files) {
    const text = await readFile(path.resolve(process.cwd(), file), "utf8");
    const { records, errors } = parseJsonLines(text);
    if (errors.length > 0) {
      console.error(`${file}: ${errors.length} unparseable line(s)`);
    }
    const analysis = analyze(records);
    results.push({ file, analysis });
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        results.map(({ file, analysis }) => ({
          file,
          userMessages: analysis.userMessages,
          assistantMessages: analysis.assistantMessages,
          toolResultMessages: analysis.toolResultMessages,
          toolCallCount: analysis.toolCallCount,
          toolErrorCount: analysis.toolErrorCount,
          toolCallTally: Object.fromEntries(analysis.toolCallTally),
          taskStateTally: Object.fromEntries(analysis.taskStateTally),
          blockOrCacheEvents: analysis.taskStateEvents.filter((event) =>
            ["forcing", "cache"].includes(event.operation),
          ),
          readHotspots: Object.fromEntries(
            [...analysis.readsByPath.entries()]
              .filter(([, reads]) => reads.length >= READ_HOTSPOT_THRESHOLD)
              .map(([target, reads]) => [target, reads.length]),
          ),
        })),
        null,
        2,
      ),
    );
    return;
  }

  for (const { file, analysis } of results) console.log(report(file, analysis));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
