// Generates run.mjs-compatible SWE-bench Verified benchmark configs
// directly from the dataset, instead of hand-writing one JSON file per
// instance (which is what the two existing pilot configs,
// swebench-verified-sympy-18211.json and -21930.json, did - not something
// that scales past a couple of instances, and hand-paraphrasing each
// problem_statement into the prompt would introduce a real, uncontrolled
// source of bias across a real sample). Turn prompts embed the dataset's
// problem_statement verbatim.
//
// Sampling is deterministic (seeded PRNG, no external dependency) so the
// exact same --seed always produces the exact same instance set - this is
// the actual reproducibility contract: anyone can regenerate the identical
// sample from this script and the dataset alone, without needing the
// generated files themselves, though they're committed too for
// convenience and transparency.
//
// Usage:
//   node scripts/evaluation/generate-swebench-configs.mjs \
//     --count 25 --seed 20260916 --output evaluation/benchmarks/generated
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DATASET = "princeton-nlp/SWE-bench_Verified";
const CANONICAL_DATASET_NAME = "SWE-bench/SWE-bench_Verified"; // matches the existing hand-written configs' benchmark.dataset field and grade-swebench.mjs's default
const PAGE_SIZE = 100;
const DEFAULT_MODEL = "ai-inference-router/gemma4:31b"; // placeholder - run.mjs's own --model flag always overrides this
const DEFAULT_TIMEOUT_MS = 1200000;
const DEFAULT_GRADING_TIMEOUT_SECONDS = 1800;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index++;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

// mulberry32 - tiny, deterministic, no dependency. Same seed always
// produces the same sequence, which is the whole point here.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, seed) {
  const rand = mulberry32(seed);
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function fetchAllRows() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}&config=default&split=test&offset=${offset}&length=${PAGE_SIZE}`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(
        `datasets-server request failed (offset=${offset}): ${response.status} ${await response.text()}`,
      );
    const body = await response.json();
    for (const entry of body.rows) rows.push(entry.row);
    if (body.rows.length < PAGE_SIZE) break;
  }
  return rows;
}

function repoUrl(repo) {
  return `https://github.com/${repo}.git`;
}

function gitCachePath(repo) {
  const repoName = repo.split("/").pop();
  return `.agent-context-card/git-cache/${repoName}.git`;
}

function buildConfig(row) {
  const instanceId = row.instance_id;
  const problem = row.problem_statement.trim();
  const expectPlan = {
    taskId: instanceId,
    resume: false,
    zeroHotEvidence: false,
  };
  const expectFollowUp = {
    taskId: instanceId,
    zeroHotEvidence: true,
    planRevision: 1,
  };
  return {
    name: `SWE-bench Verified ${instanceId}`,
    model: DEFAULT_MODEL,
    thinking: "off",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    noContextFiles: true,
    benchmark: {
      dataset: CANONICAL_DATASET_NAME,
      split: "test",
      instanceId,
      difficulty: row.difficulty,
      timeoutSeconds: DEFAULT_GRADING_TIMEOUT_SECONDS,
      cacheLevel: "env",
    },
    workspace: {
      type: "git",
      source: repoUrl(row.repo),
      cache: gitCachePath(row.repo),
      commit: row.base_commit,
      timeoutMs: 300000,
    },
    variants: [
      { name: "baseline", extension: false, sessionMode: "continue" },
      { name: "card", extension: true, sessionMode: "continue" },
    ],
    turns: [
      {
        name: "plan",
        prompt: `Plan ${instanceId}. Inspect the repository and produce a concise implementation and validation plan. Do not modify files.\n\nIssue:\n${problem}`,
        expect: expectPlan,
      },
      {
        name: "implement",
        prompt: `Implement ${instanceId} with a minimal production fix.\n\nIssue:\n${problem}\n\nInspect current source before editing and run the most relevant focused test available.`,
        expect: expectFollowUp,
      },
      {
        name: "review",
        prompt: `Review ${instanceId} against the issue. Inspect the current diff and run only a bounded direct reproduction or one focused test; do not run broad suites or install dependencies. Fix only correctness problems you find. The official benchmark harness will perform final grading.`,
        expect: expectFollowUp,
      },
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const count = Number.parseInt(String(args.count ?? "25"), 10);
  const seed = Number.parseInt(String(args.seed ?? "20260916"), 10);
  const outputDir = path.resolve(
    process.cwd(),
    String(args.output ?? "evaluation/benchmarks/generated"),
  );
  await mkdir(outputDir, { recursive: true });

  console.log(`Fetching all rows from ${DATASET}...`);
  const rows = await fetchAllRows();
  console.log(`Fetched ${rows.length} instances.`);

  const sampled = seededShuffle(rows, seed).slice(0, count);
  console.log(`Sampled ${sampled.length} instances (seed=${seed}).`);

  const manifest = [];
  for (const row of sampled) {
    const config = buildConfig(row);
    const fileName = `${safeName(row.instance_id)}.json`;
    const configPath = path.join(outputDir, fileName);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    manifest.push({
      id: row.instance_id,
      configPath: path
        .relative(process.cwd(), configPath)
        .split(path.sep)
        .join("/"),
      repo: row.repo,
      difficulty: row.difficulty,
    });
  }

  const manifestPath = path.join(outputDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifest.length} configs to ${outputDir}`);
  console.log(`Manifest: ${manifestPath}`);

  const byDifficulty = {};
  for (const entry of manifest)
    byDifficulty[entry.difficulty] = (byDifficulty[entry.difficulty] ?? 0) + 1;
  console.log("Difficulty distribution:", byDifficulty);
  const byRepo = {};
  for (const entry of manifest)
    byRepo[entry.repo] = (byRepo[entry.repo] ?? 0) + 1;
  console.log("Repo distribution:", byRepo);
}

await main();
