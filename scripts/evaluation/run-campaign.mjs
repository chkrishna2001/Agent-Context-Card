// Multi-day-safe orchestrator for running many SWE-bench instances across
// multiple models. Built specifically for the free-tier constraint: Ollama
// Cloud and Cloudflare Workers AI free plans can run out of daily
// quota/rate limit mid-campaign, and when that happens every subsequent
// call to that same model will fail the same way until the quota resets
// (typically the next day) - continuing to burn through the remaining
// queue just produces a wall of identical failures. This script instead
// stops the whole campaign the moment two combos in a row look like a
// quota/outage problem, and is safe to just re-invoke with the exact same
// command the next day: already-completed combos are detected from their
// output directory and skipped, so it resumes exactly where it left off.
//
// Usage:
//   node scripts/evaluation/run-campaign.mjs \
//     --instances evaluation/benchmarks/campaign-instances.json \
//     --models "ai-inference-router/gemma4:31b,ai-inference-router/@cf/zai-org/glm-4.7-flash" \
//     --repeats 3 \
//     --output .agent-context-card/e/campaign-2026-09-16
//
// --instances points to a JSON file: an array of { "id": string, "configPath": string }.
// --models is a comma-separated list of provider/model strings, run.mjs's own format.
import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

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

// A run "looks done" only if report.json exists, parses, and has the
// expected number of runs (baseline+card, `repeats` each) - a partial or
// crashed attempt (no report.json, or one from an earlier --repeats value)
// is not treated as done, so it gets retried rather than silently skipped.
async function reportLooksDone(reportPath, expectedRunCount) {
  try {
    const raw = await readFile(reportPath, "utf8");
    const report = JSON.parse(raw);
    return Array.isArray(report.runs) && report.runs.length >= expectedRunCount;
  } catch {
    return false;
  }
}

// Fraction of provider requests across the whole report that came back as
// provider errors. A report with zero requests at all (crashed before
// making any call) is treated as fully bad (rate 1), not skipped as
// vacuously fine.
async function providerErrorRate(reportPath) {
  const raw = await readFile(reportPath, "utf8");
  const report = JSON.parse(raw);
  let requests = 0;
  let errors = 0;
  for (const run of report.runs ?? []) {
    requests += run.aggregate?.providerRequests ?? 0;
    errors += run.aggregate?.providerErrors ?? 0;
  }
  if (requests === 0) return 1;
  return errors / requests;
}

function runOne(configPath, model, outputDir, repeats) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(scriptDirectory, "run.mjs"),
        "--config",
        configPath,
        "--model",
        model,
        "--output",
        outputDir,
        "--repeats",
        String(repeats),
      ],
      { stdio: "inherit", cwd: process.cwd() },
    );
    child.on("close", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });
}

// Two bad combos in a row (crashed with no usable report, or a majority of
// provider requests errored) is treated as quota/rate-limit exhaustion or
// a service outage, not a fluke on one hard instance - a single bad combo
// is common and expected (a genuinely hard SWE-bench instance, a transient
// network blip) and must not halt the whole campaign.
const CONSECUTIVE_BAD_STOP_THRESHOLD = 2;
const HIGH_ERROR_RATE_THRESHOLD = 0.5;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.instances || !args.models || !args.output)
    throw new Error(
      "Usage: node scripts/evaluation/run-campaign.mjs --instances <manifest.json> --models <p/m,p/m,...> --output <dir> [--repeats n]",
    );
  const instances = JSON.parse(
    await readFile(path.resolve(process.cwd(), args.instances), "utf8"),
  );
  const models = String(args.models)
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const repeats = Number.parseInt(String(args.repeats ?? "3"), 10);
  const expectedRunCount = repeats * 2; // baseline + card, each repeated `repeats` times
  const campaignRoot = path.resolve(process.cwd(), args.output);
  await mkdir(campaignRoot, { recursive: true });

  const summary = { done: 0, skipped: 0, badExit: 0, highErrorRate: 0 };

  for (const model of models) {
    const modelDir = safeName(model);
    let consecutiveBad = 0;
    for (const instance of instances) {
      const outputDir = path.join(campaignRoot, instance.id, modelDir);
      const reportPath = path.join(outputDir, "report.json");

      if (await reportLooksDone(reportPath, expectedRunCount)) {
        console.log(`SKIP (already complete): ${instance.id} / ${model}`);
        summary.skipped++;
        continue;
      }

      console.log(`\nRUNNING: ${instance.id} / ${model}`);
      const exitCode = await runOne(
        instance.configPath,
        model,
        outputDir,
        repeats,
      );
      const done = await reportLooksDone(reportPath, expectedRunCount);

      if (!done) {
        console.error(
          `CRASHED (no usable report.json): ${instance.id} / ${model}, exit=${exitCode}`,
        );
        summary.badExit++;
        consecutiveBad++;
      } else {
        const rate = await providerErrorRate(reportPath);
        if (rate > HIGH_ERROR_RATE_THRESHOLD) {
          console.error(
            `HIGH PROVIDER ERROR RATE (${(rate * 100).toFixed(0)}%): ${instance.id} / ${model}`,
          );
          summary.highErrorRate++;
          consecutiveBad++;
        } else {
          console.log(`OK: ${instance.id} / ${model}`);
          summary.done++;
          consecutiveBad = 0;
        }
      }

      if (consecutiveBad >= CONSECUTIVE_BAD_STOP_THRESHOLD) {
        console.error(
          `\nSTOPPING CAMPAIGN: ${consecutiveBad} combos in a row for ${model} ` +
            `looked like quota/rate-limit exhaustion or a service outage, not ` +
            `an isolated instance failure.`,
        );
        console.error(
          `Re-run this exact same command (same --instances/--models/--output) ` +
            `once the quota has reset (typically the next day) - already-` +
            `completed combos are detected from their output directory and ` +
            `skipped automatically, so it resumes right where it stopped.`,
        );
        console.error(
          `Progress so far: ${summary.done} done, ${summary.skipped} skipped, ` +
            `${summary.badExit} crashed, ${summary.highErrorRate} high-error-rate.`,
        );
        process.exitCode = 1;
        return;
      }
    }
  }

  console.log(
    `\nCampaign complete: ${summary.done} done, ${summary.skipped} skipped, ` +
      `${summary.badExit} crashed, ${summary.highErrorRate} high-error-rate.`,
  );
}

await main();
