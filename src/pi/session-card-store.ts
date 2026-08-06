import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseTaskSnapshot } from "../core/continuity";
import type { RepositoryProvenance, TaskSnapshot } from "../core/types";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type LoadResult =
  | { status: "success"; snapshot: TaskSnapshot }
  | { status: "missing" }
  | { status: "corrupt"; detail: string };

function filenameFor(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`unsafe session id: ${sessionId}`);
  }
  return `card-${sessionId}.json`;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function repositoryIdentity(cwd: string): {
  root: string;
  head?: string;
} {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? path.resolve(cwd);
  return { root: path.resolve(root), head: git(cwd, ["rev-parse", "HEAD"]) };
}

export function repositoryProvenance(cwd: string): RepositoryProvenance {
  const { root, head } = repositoryIdentity(cwd);
  const tracked =
    git(cwd, [
      "diff",
      "--binary",
      "HEAD",
      "--",
      ".",
      ":(exclude).agent-context-card",
    ]) ?? "unavailable";
  const untracked =
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
      ?.split("\0")
      .filter((name) => name && !name.startsWith(".agent-context-card/")) ?? [];
  const worktreeHash = createHash("sha256").update(tracked);
  for (const name of untracked.sort()) {
    worktreeHash.update(`\0${name}\0`);
    try {
      worktreeHash.update(readFileSync(path.join(root, name)));
    } catch {
      worktreeHash.update("unreadable");
    }
  }
  return { root, head, worktree: worktreeHash.digest("hex") };
}

/**
 * Persists one context card per Pi session, keyed by the session's own ID.
 * Global by default (not project-local) so a card survives a process
 * restart regardless of whether the user ever typed a ticket-ID-shaped
 * string; the previous task-ID-keyed store required that and, in practice,
 * almost never persisted anything.
 */
export class SessionCardStore {
  readonly directory: string;
  private readonly corrupt = new Set<string>();

  constructor(baseDir?: string) {
    this.directory =
      baseDir ?? path.join(homedir(), ".agent-context-card", "cards");
  }

  pathFor(sessionId: string): string {
    return path.join(this.directory, filenameFor(sessionId));
  }

  async load(sessionId: string): Promise<LoadResult> {
    const file = this.pathFor(sessionId);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "missing" };
      this.corrupt.add(sessionId);
      return { status: "corrupt", detail: String(error) };
    }
    try {
      const snapshot = parseTaskSnapshot(JSON.parse(text));
      if (!snapshot || snapshot.sessionId !== sessionId)
        throw new Error("snapshot schema or session ID is invalid");
      return { status: "success", snapshot };
    } catch (error) {
      this.corrupt.add(sessionId);
      return { status: "corrupt", detail: String(error) };
    }
  }

  async save(snapshot: TaskSnapshot): Promise<void> {
    if (this.corrupt.has(snapshot.sessionId))
      throw new Error("refusing to overwrite a corrupt session card");
    await mkdir(this.directory, { recursive: true });
    const target = this.pathFor(snapshot.sessionId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(snapshot, null, 2)}\n`,
        "utf8",
      );
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async remove(sessionId: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(sessionId));
      this.corrupt.delete(sessionId);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async collectGarbage(now = Date.now()): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names.filter((candidate) =>
      candidate.endsWith(".json"),
    )) {
      const file = path.join(this.directory, name);
      if (now - (await stat(file)).mtimeMs <= MAX_AGE_MS) continue;
      await unlink(file);
      removed++;
    }
    return removed;
  }
}
