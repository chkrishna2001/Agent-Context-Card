// Batch-grades every instance/model combo produced by run-campaign.mjs,
// invoking grade-swebench.mjs once per combo (it internally grades every
// run - baseline+card, all repeats - in that combo's report.json). Exists
// because grading 50 combos (25 instances x 2 models) by hand, one
// `--report` invocation at a time, is exactly the "useful next small tool"
// gap flagged in docs/plans/swebench-pilot-campaign.md step 3.
//
// Each grading run needs a real Docker build (SWE-bench's own harness
// builds base/env/instance images per repo+commit). The FIRST combo for a
// given repo is expensive (~10 min, cold image build); later combos on the
// same repo reuse cached layers and land closer to ~2 min/run. Budget
// accordingly across a manifest spanning several repos - this is a
// multi-hour job for a full campaign, not a quick pass.
//
// Usage:
//   node scripts/evaluation/grade-campaign.mjs --root <campaign-output-dir> [--wsl]
//
// Safe to re-run: a combo already holding a swebench-grades/<id>/grades.json
// with the expected number of grades (report.runs.length) is skipped.
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
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

// Combo report.json files sit at exactly <root>/<instanceId>/<modelDir>/report.json.
// Grading itself also writes files literally named "report.json" (the
// official SWE-bench harness's own per-candidate output) nested under
// swebench-grades/ - staying at a fixed depth avoids ever matching those.
async function findComboReports(root) {
  const combos = [];
  const instanceDirs = await readdir(root, { withFileTypes: true });
  for (const instanceDir of instanceDirs) {
    if (!instanceDir.isDirectory()) continue;
    const instancePath = path.join(root, instanceDir.name);
    const modelDirs = await readdir(instancePath, { withFileTypes: true });
    for (const modelDir of modelDirs) {
      if (!modelDir.isDirectory()) continue;
      const reportPath = path.join(instancePath, modelDir.name, "report.json");
      try {
        await readFile(reportPath, "utf8");
        combos.push({
          instanceId: instanceDir.name,
          modelDir: modelDir.name,
          reportPath,
        });
      } catch {
        // No report.json here - not a completed combo, nothing to grade.
      }
    }
  }
  return combos;
}

async function alreadyGraded(reportPath, expectedGradeCount) {
  const gradesRoot = path.join(path.dirname(reportPath), "swebench-grades");
  let invocationDirs;
  try {
    invocationDirs = await readdir(gradesRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const invocationDir of invocationDirs) {
    if (!invocationDir.isDirectory()) continue;
    const gradesPath = path.join(gradesRoot, invocationDir.name, "grades.json");
    try {
      const data = JSON.parse(await readFile(gradesPath, "utf8"));
      if (Array.isArray(data.grades) && data.grades.length >= expectedGradeCount) {
        return true;
      }
    } catch {
      // Incomplete/corrupt invocation - keep looking, then fall through to re-grade.
    }
  }
  return false;
}

function gradeOne(reportPath, useWsl) {
  return new Promise((resolve) => {
    const args = [
      path.join(scriptDirectory, "grade-swebench.mjs"),
      "--report",
      reportPath,
    ];
    if (useWsl) args.push("--wsl");
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("close", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });
}

const CONSECUTIVE_BAD_STOP_THRESHOLD = 2;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root)
    throw new Error(
      "Usage: node scripts/evaluation/grade-campaign.mjs --root <campaign-output-dir> [--wsl] [--shard i/n]",
    );
  const root = path.resolve(process.cwd(), args.root);
  const useWsl = Boolean(args.wsl);
  let combos = await findComboReports(root);
  combos.sort((a, b) =>
    `${a.instanceId}/${a.modelDir}`.localeCompare(`${b.instanceId}/${b.modelDir}`),
  );

  // --shard i/n splits N parallel invocations' work evenly. Sharding is
  // applied AFTER filtering out already-graded combos (not over the raw
  // list) so a lopsided already-done set - e.g. one shard's combos all
  // happening to be graded already - can't starve one shard while dumping
  // all remaining work on the other, which a plain index-modulo split over
  // the full list is vulnerable to whenever the combo count per shard
  // isn't evenly distributed (it wasn't here: two extra GLM combos shifted
  // the even/odd parity partway through the sorted list).
  if (args.shard) {
    const [shardIndex, shardCount] = String(args.shard).split("/").map(Number);
    if (
      !Number.isInteger(shardIndex) ||
      !Number.isInteger(shardCount) ||
      shardIndex < 0 ||
      shardIndex >= shardCount
    )
      throw new Error("--shard must be 'i/n' with 0 <= i < n");
    const todo = [];
    for (const combo of combos) {
      const report = JSON.parse(await readFile(combo.reportPath, "utf8"));
      const expectedGradeCount = Array.isArray(report.runs) ? report.runs.length : 0;
      if (!(await alreadyGraded(combo.reportPath, expectedGradeCount))) todo.push(combo);
    }
    combos = todo.filter((_, index) => index % shardCount === shardIndex);
  }

  const summary = { done: 0, skipped: 0, badExit: 0 };
  let consecutiveBad = 0;
  const cancelPath = path.join(root, "CANCEL");

  for (const combo of combos) {
    // Same convention as run-campaign.mjs: checked between combos only,
    // never mid-grade, so a stop request always waits for the in-flight
    // Docker grading to finish rather than leaving a partial invocation
    // directory behind.
    try {
      await readFile(cancelPath);
      console.log(
        `\nCANCELLED: found ${cancelPath} - stopping after the last completed combo (delete this file before resuming).`,
      );
      break;
    } catch {
      // No cancel file - keep going.
    }
    const report = JSON.parse(await readFile(combo.reportPath, "utf8"));
    const expectedGradeCount = Array.isArray(report.runs) ? report.runs.length : 0;
    if (await alreadyGraded(combo.reportPath, expectedGradeCount)) {
      console.log(`SKIP (already graded): ${combo.instanceId} / ${combo.modelDir}`);
      summary.skipped++;
      continue;
    }
    console.log(`\nGRADING: ${combo.instanceId} / ${combo.modelDir}`);
    const code = await gradeOne(combo.reportPath, useWsl);
    if (code === 0) {
      console.log(`OK: ${combo.instanceId} / ${combo.modelDir}`);
      summary.done++;
      consecutiveBad = 0;
    } else {
      console.log(`FAILED (exit ${code}): ${combo.instanceId} / ${combo.modelDir}`);
      summary.badExit++;
      consecutiveBad++;
      if (consecutiveBad >= CONSECUTIVE_BAD_STOP_THRESHOLD) {
        console.log(
          `\nSTOPPING: ${consecutiveBad} grading failures in a row - looks like a systemic Docker/WSL problem, not an isolated instance issue.\n` +
            "Fix the underlying issue and re-run this exact same command - already-graded combos are skipped automatically.",
        );
        break;
      }
    }
  }

  console.log(
    `\nGrading campaign complete: ${summary.done} done, ${summary.skipped} skipped, ${summary.badExit} failed.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
