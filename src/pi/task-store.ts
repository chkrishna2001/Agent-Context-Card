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
import path from "node:path";
import { parseTaskSnapshot } from "../core/continuity";
import type { RepositoryProvenance, TaskSnapshot } from "../core/types";

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export type LoadResult =
  | { status: "success"; snapshot: TaskSnapshot }
  | { status: "missing" }
  | { status: "corrupt"; detail: string };

function filenameFor(taskId: string): string {
  const encoded = encodeURIComponent(taskId);
  const digest = createHash("sha256").update(taskId).digest("hex").slice(0, 12);
  return `${encoded}-${digest}.json`;
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

export function repositoryProvenance(cwd: string): RepositoryProvenance {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]) ?? path.resolve(cwd);
  const head = git(cwd, ["rev-parse", "HEAD"]);
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
  return {
    root: path.resolve(root),
    head,
    worktree: worktreeHash.digest("hex"),
  };
}

export class TaskStore {
  readonly directory: string;
  private readonly corrupt = new Set<string>();

  constructor(cwd: string) {
    this.directory = path.join(cwd, ".agent-context-card", "tasks");
  }

  pathFor(taskId: string): string {
    return path.join(this.directory, filenameFor(taskId));
  }

  async load(taskId: string): Promise<LoadResult> {
    const file = this.pathFor(taskId);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "missing" };
      this.corrupt.add(taskId);
      return { status: "corrupt", detail: String(error) };
    }
    try {
      const snapshot = parseTaskSnapshot(JSON.parse(text));
      if (!snapshot || snapshot.taskId !== taskId)
        throw new Error("snapshot schema or task ID is invalid");
      return { status: "success", snapshot };
    } catch (error) {
      this.corrupt.add(taskId);
      return { status: "corrupt", detail: String(error) };
    }
  }

  async save(snapshot: TaskSnapshot): Promise<void> {
    if (this.corrupt.has(snapshot.taskId))
      throw new Error("refusing to overwrite a corrupt task snapshot");
    await mkdir(this.directory, { recursive: true });
    const target = this.pathFor(snapshot.taskId);
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

  async remove(taskId: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(taskId));
      this.corrupt.delete(taskId);
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
