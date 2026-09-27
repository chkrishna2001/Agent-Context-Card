// Copies a run-campaign.mjs output directory into a small, publishable
// export: everything a researcher needs to verify token/cost/correctness
// claims (report.json/md, prediction.json, run.json, turn results, session
// and turn transcripts), minus the one thing that makes campaign output
// directories huge - the "w" subdirectory under every run, which is just a
// full `git clone` of the target repo (django/sympy/sphinx/pylint, already
// public and reproducible from the SWE-bench instance's base commit, not
// unique data worth archiving).
//
// .jsonl transcripts are gzipped on the way out - they're highly repetitive
// (each provider call re-sends most of the prior context) and compress
// ~100x in practice, which also keeps individual files well clear of
// GitHub's 100MB per-file limit that a raw multi-turn GLM transcript could
// otherwise approach.
//
// Usage:
//   node scripts/evaluation/export-campaign-results.mjs \
//     --input .agent-context-card/e/pilot-25 \
//     --output evaluation/results/swebench-pilot-25
//
// Safe to re-run as a campaign progresses: copies are additive/overwriting,
// nothing is deleted from --output that isn't also being replaced.
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const SKIP_DIR_NAMES = new Set(["w"]);

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

async function copyTree(inputDir, outputDir) {
  let fileCount = 0;
  let skippedDirs = 0;

  async function walk(currentInput, currentOutput) {
    const entries = await readdir(currentInput, { withFileTypes: true });
    for (const entry of entries) {
      const inputPath = path.join(currentInput, entry.name);
      const outputPath = path.join(currentOutput, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) {
          skippedDirs++;
          continue;
        }
        await mkdir(outputPath, { recursive: true });
        await walk(inputPath, outputPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".jsonl")) {
          await pipeline(
            createReadStream(inputPath),
            createGzip(),
            createWriteStream(`${outputPath}.gz`),
          );
        } else {
          await cp(inputPath, outputPath);
        }
        fileCount++;
      }
    }
  }

  await mkdir(outputDir, { recursive: true });
  await walk(inputDir, outputDir);
  return { fileCount, skippedDirs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    throw new Error(
      "Usage: node scripts/evaluation/export-campaign-results.mjs --input <campaign-output-dir> --output <export-dir>",
    );
  }
  const inputDir = path.resolve(process.cwd(), args.input);
  const outputDir = path.resolve(process.cwd(), args.output);

  const inputStats = await stat(inputDir).catch(() => null);
  if (!inputStats || !inputStats.isDirectory()) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  const { fileCount, skippedDirs } = await copyTree(inputDir, outputDir);
  console.log(
    `Exported ${fileCount} files from ${inputDir} to ${outputDir} (skipped ${skippedDirs} workspace clone dirs).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
