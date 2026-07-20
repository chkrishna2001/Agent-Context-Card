import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectCapabilities } from "./types";

const VALIDATION_SCRIPTS = [
  "test",
  "build",
  "lint",
  "typecheck",
  "check",
  "format",
];

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function packageManager(cwd: string): string | undefined {
  if (existsSync(join(cwd, "bun.lock"))) return "bun";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";
  return existsSync(join(cwd, "package.json")) ? "npm" : undefined;
}

export function buildProjectCapabilities(cwd: string): ProjectCapabilities {
  const packageJson = readJson(join(cwd, "package.json"));
  const manager = packageManager(cwd);
  const scripts =
    packageJson?.scripts && typeof packageJson.scripts === "object"
      ? (packageJson.scripts as Record<string, unknown>)
      : {};
  const validation = VALIDATION_SCRIPTS.flatMap((name) =>
    typeof scripts[name] === "string" && manager
      ? [`${manager} run ${name}`]
      : [],
  );
  if (existsSync(join(cwd, "mise.toml"))) {
    for (const task of VALIDATION_SCRIPTS) {
      if (
        existsSync(join(cwd, ".mise", "tasks", task)) &&
        !validation.includes(`mise run ${task}`)
      )
        validation.push(`mise run ${task}`);
    }
  }

  const documentation = [
    ["README.md", join(cwd, "README.md")],
    ["docs/", join(cwd, "docs")],
  ].flatMap(([label, path]) => (existsSync(path) ? [label!] : []));
  const browserExtension =
    existsSync(join(cwd, "manifest.json")) ||
    existsSync(join(cwd, "manifest.chrome.json")) ||
    existsSync(join(cwd, "manifest.firefox.json"));

  return {
    projectType: browserExtension ? "browser extension" : undefined,
    packageName:
      typeof packageJson?.name === "string" ? packageJson.name : undefined,
    packageManager: manager,
    documentation,
    validation,
  };
}
