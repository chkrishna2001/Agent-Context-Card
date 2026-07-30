import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mergeExecutionJournals,
  isPlanningRequest,
  parseTaskSnapshot,
  promotePlan,
  taskIdFromInput,
  unresolvedPriorExecution,
} from "../src/core/continuity";
import type { ExecutionJournal, TaskSnapshot } from "../src/core/types";
import {
  repositoryProvenance,
  SessionCardStore,
} from "../src/pi/session-card-store";

const prior: ExecutionJournal = {
  changes: [
    {
      action: "shell_command bun test",
      kind: "validation",
      status: "success",
      count: 1,
    },
  ],
  failures: [
    {
      action: "shell_command bun x tsc --noEmit",
      kind: "validation",
      status: "failed",
      count: 1,
    },
  ],
};

describe("cross-session continuity", () => {
  test("extracts only supported exact task ID forms", () => {
    expect(taskIdFromInput("continue JIRA-123 please")).toBe("JIRA-123");
    expect(taskIdFromInput("fix django__django-12345")).toBe(
      "django__django-12345",
    );
    expect(taskIdFromInput("../../secrets")).toBeUndefined();
  });

  test("promotes exact plan text and exposes revisions", () => {
    const first = promotePlan({
      content: "1. Read\n2. Edit",
      sourceTurn: 0,
      capturedAt: "2026-07-21T00:00:00.000Z",
    });
    const second = promotePlan(
      {
        content: "1. Read\n2. Test",
        sourceTurn: 1,
        capturedAt: "2026-07-21T01:00:00.000Z",
      },
      first,
    );
    expect(first.content).toBe("1. Read\n2. Edit");
    expect(second.revision).toBe(2);
  });

  test("detects planning intent without treating plan references as replans", () => {
    expect(isPlanningRequest("Plan JIRA-123 after inspecting the files")).toBe(
      true,
    );
    expect(isPlanningRequest("Please draft an implementation plan")).toBe(true);
    expect(isPlanningRequest("Can you plan this change?")).toBe(true);
    expect(isPlanningRequest("Implement it and follow the approved plan")).toBe(
      false,
    );
    expect(isPlanningRequest("Validate the plan implementation")).toBe(false);
  });

  test("a current matching success resolves a prior failure", () => {
    const current: ExecutionJournal = {
      changes: [
        {
          action: "shell_command bun x tsc --noEmit",
          kind: "validation",
          status: "success",
          count: 1,
        },
      ],
      failures: [],
    };
    expect(unresolvedPriorExecution(prior, current).failures).toEqual([]);
    expect(mergeExecutionJournals(prior, current).changes).toHaveLength(2);
  });
});

describe("session card store", () => {
  test("round-trips atomically and refuses to overwrite corruption", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-"));
    const cardsDir = await mkdtemp(path.join(tmpdir(), "context-card-cards-"));
    try {
      const store = new SessionCardStore(cardsDir);
      const snapshot: TaskSnapshot = {
        schemaVersion: 1,
        sessionId: "session-xyz",
        anchor: { goal: "Plan the payment refactor", createdAtTurn: 0 },
        execution: prior,
        provenance: repositoryProvenance(cwd),
        updatedAt: "2026-07-21T00:00:00.000Z",
      };
      await store.save(snapshot);
      expect(await store.load("session-xyz")).toEqual({
        status: "success",
        snapshot,
      });

      const revised = { ...snapshot, updatedAt: "2026-07-21T01:00:00.000Z" };
      await store.save(revised);
      expect(await store.load("session-xyz")).toEqual({
        status: "success",
        snapshot: revised,
      });

      await writeFile(store.pathFor("session-xyz"), "{broken", "utf8");
      expect((await store.load("session-xyz")).status).toBe("corrupt");
      await expect(store.save(snapshot)).rejects.toThrow(
        "refusing to overwrite",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(cardsDir, { recursive: true, force: true });
    }
  });

  test("rejects partial snapshot schemas", () => {
    expect(parseTaskSnapshot({ schemaVersion: 1 })).toBeUndefined();
  });

  test("missing sessions fail closed and garbage collection preserves recent state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "context-card-gc-"));
    const cardsDir = await mkdtemp(
      path.join(tmpdir(), "context-card-gc-cards-"),
    );
    try {
      const store = new SessionCardStore(cardsDir);
      expect(await store.load("s-1")).toEqual({ status: "missing" });
      const snapshot = (sessionId: string): TaskSnapshot => ({
        schemaVersion: 1,
        sessionId,
        anchor: { goal: sessionId, createdAtTurn: 0 },
        execution: { changes: [], failures: [] },
        provenance: repositoryProvenance(cwd),
        updatedAt: "2026-07-21T00:00:00.000Z",
      });
      await store.save(snapshot("s-1"));
      await store.save(snapshot("s-2"));
      const now = Date.now();
      await utimes(
        store.pathFor("s-1"),
        new Date(now - 31 * 24 * 60 * 60 * 1_000),
        new Date(now - 31 * 24 * 60 * 60 * 1_000),
      );
      expect(await store.collectGarbage(now)).toBe(1);
      expect(await store.load("s-1")).toEqual({ status: "missing" });
      expect((await store.load("s-2")).status).toBe("success");
      expect(await store.remove("s-2")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(cardsDir, { recursive: true, force: true });
    }
  });
});
