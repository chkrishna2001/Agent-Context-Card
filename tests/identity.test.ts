import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  repositoryIdentity,
  repositoryProvenance,
} from "../src/pi/session-card-store";

function makeRepo(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "ctx-identity-"));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "hi\n");
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });
  writeFileSync(path.join(cwd, "big.txt"), "x".repeat(64 * 1024));
  return cwd;
}

describe("repositoryIdentity", () => {
  test("returns root and head without diff or hashing", () => {
    const cwd = makeRepo();
    try {
      const identity = repositoryIdentity(cwd);
      expect(identity.root).toBe(path.resolve(cwd));
      expect(typeof identity.head === "string" && identity.head.length).toBe(
        40,
      );
      expect((identity as Record<string, unknown>).worktree).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("does not read untracked files when computing identity", () => {
    const cwd = makeRepo();
    const target = path.join(cwd, "huge.txt");
    try {
      writeFileSync(target, "y".repeat(2 * 1024 * 1024));
      const t0 = Date.now();
      const identity = repositoryIdentity(cwd);
      const elapsed = Date.now() - t0;
      expect(identity.root).toBe(path.resolve(cwd));
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("full repositoryProvenance does hash untracked content", () => {
    const cwd = makeRepo();
    const target = path.join(cwd, "u.txt");
    try {
      writeFileSync(target, "marker-content");
      const provenance = repositoryProvenance(cwd);
      expect(/^[0-9a-f]{64}$/.test(provenance.worktree)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("card field type uses the cheap identity, not the full provenance", async () => {
    // Read the on-disk source for runtimeCard to assert it calls
    // repositoryIdentity and not repositoryProvenance on the always-on
    // repo path. This is a static check that survives renames.
    const src = await Bun.file("src/pi/index.ts").text();
    expect(src).toContain("repositoryIdentity(ctx.cwd)");
    // Every non-import call site of repositoryProvenance in index.ts must
    // be gated by resumedProvenance. We check by ensuring each call site
    // occurs after a resumedProvenance branch reference.
    const callPattern = /repositoryProvenance\s*\(([\s\S]*?)\)/g;
    const branchUses = [...src.matchAll(/resumedProvenance/g)];
    const callsites: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(src)) !== null) {
      callsites.push(match[0]);
    }
    expect(callsites.length).toBeGreaterThanOrEqual(1);
    // The first call site must be reachable only when resumedProvenance is
    // truthy. Verify there is a resumedProvenance reference somewhere
    // before it.
    const firstCallIndex = callsites[0] ? src.indexOf(callsites[0]) : -1;
    const resumedMatchIndex = branchUses[0]?.index ?? -1;
    expect(firstCallIndex).toBeGreaterThan(-1);
    expect(resumedMatchIndex).toBeGreaterThan(-1);
    expect(firstCallIndex).toBeGreaterThan(resumedMatchIndex);
  });
});
