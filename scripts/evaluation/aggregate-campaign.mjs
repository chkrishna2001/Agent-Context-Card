// Aggregates a full run-campaign.mjs + grade-campaign.mjs output into
// paper-ready summary statistics: per-model token/cost distributions
// (absolute, and paired baseline-vs-card percent change), and correctness
// counts - pooled across every instance and repeat, not just per-instance.
//
// This is the piece flagged as missing in docs/plans/swebench-pilot-campaign.md
// step 4: run.mjs's own repeatSummary only aggregates repeats of one
// instance; nothing pools results across a whole campaign until this.
//
// Per the same doc's own stated lessons: report medians AND ranges, not
// point estimates, and report correctness plainly alongside efficiency -
// so this script always emits distribution() (count/min/max/mean/median),
// never a single number, and always reports resolved/failed/ungraded
// counts next to the token/cost deltas.
//
// Usage:
//   node scripts/evaluation/aggregate-campaign.mjs --root <campaign-output-dir> [--output <dir>]
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { distribution, percentChange } from "./metrics.mjs";

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

// Same fixed-depth walk grade-campaign.mjs uses, for the same reason: avoid
// ever matching a nested report.json written by the SWE-bench harness
// itself under swebench-grades/.
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
          model: modelDir.name,
          reportPath,
        });
      } catch {
        // No report.json here - not a completed combo.
      }
    }
  }
  return combos;
}

// Reads every swebench-grades/<invocationId>/grades.json for this combo and
// returns the most complete one (by grade count), so a combo that was
// re-graded after an earlier partial/failed attempt uses the good data.
async function loadBestGrades(reportPath, expectedCount) {
  const gradesRoot = path.join(path.dirname(reportPath), "swebench-grades");
  let invocationDirs;
  try {
    invocationDirs = await readdir(gradesRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const invocationDir of invocationDirs) {
    if (!invocationDir.isDirectory()) continue;
    const gradesPath = path.join(gradesRoot, invocationDir.name, "grades.json");
    try {
      const data = JSON.parse(await readFile(gradesPath, "utf8"));
      if (!Array.isArray(data.grades)) continue;
      if (!best || data.grades.length > best.grades.length) best = data;
    } catch {
      // Corrupt/partial invocation - skip.
    }
  }
  if (!best || best.grades.length < expectedCount) return null;
  return best;
}

// The metrics pooled across every instance/repeat for both the absolute
// distribution and the paired baseline-vs-card percent-change distribution.
// Kept deliberately small and focused on what the paper actually needs
// (tokens the pilot was built to measure, cost because that's the thing the
// Haiku investigation showed can diverge from token counts).
const POOLED_METRICS = {
  providerInputTokens: (run) => run.aggregate.usage.providerInput,
  totalTokens: (run) => run.aggregate.usage.totalTokens,
  costUsd: (run) => run.aggregate.usage.cost.total,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root)
    throw new Error(
      "Usage: node scripts/evaluation/aggregate-campaign.mjs --root <campaign-output-dir> [--output <dir>]",
    );
  const root = path.resolve(process.cwd(), args.root);
  const outputDir = path.resolve(process.cwd(), args.output ?? root);
  await mkdir(outputDir, { recursive: true });

  const combos = await findComboReports(root);

  // model -> { instances: Set, ungradedCombos: [], variants: { name -> { runs: [], correctness } },
  //            pooled: { metricName -> { baselineValues: [], candidateValues: [], pairedPercentChanges: [] } } }
  const byModel = new Map();

  for (const combo of combos) {
    const report = JSON.parse(await readFile(combo.reportPath, "utf8"));
    const runs = Array.isArray(report.runs) ? report.runs : [];
    if (runs.length === 0) continue;

    const grades = await loadBestGrades(combo.reportPath, runs.length);
    const resolvedByRunName = new Map(
      (grades?.grades ?? []).map((grade) => [grade.run, grade.official?.resolved]),
    );

    const model = combo.model;
    if (!byModel.has(model)) {
      byModel.set(model, {
        instances: new Set(),
        ungradedCombos: [],
        variants: new Map(),
        pooled: new Map(Object.keys(POOLED_METRICS).map((name) => [name, {
          baselineValues: [],
          candidateValues: [],
          pairedPercentChanges: [],
        }])),
      });
    }
    const modelAgg = byModel.get(model);
    modelAgg.instances.add(combo.instanceId);
    if (!grades) modelAgg.ungradedCombos.push(`${combo.instanceId}/${model}`);

    for (const run of runs) {
      const resolved = resolvedByRunName.get(run.name);
      run.correct = resolved === undefined ? undefined : resolved;

      if (!modelAgg.variants.has(run.variant)) {
        modelAgg.variants.set(run.variant, {
          runs: 0,
          correctness: { passed: 0, failed: 0, ungraded: 0 },
        });
      }
      const variantAgg = modelAgg.variants.get(run.variant);
      variantAgg.runs++;
      if (run.correct === true) variantAgg.correctness.passed++;
      else if (run.correct === false) variantAgg.correctness.failed++;
      else variantAgg.correctness.ungraded++;
    }

    // Paired (same instance, same repeat) baseline-vs-card percent change,
    // per the plan doc's own comparison convention.
    const baselineByRepeat = new Map(
      runs.filter((run) => run.variant === "baseline").map((run) => [run.repeat, run]),
    );
    const candidateByRepeat = new Map(
      runs.filter((run) => run.variant === "card").map((run) => [run.repeat, run]),
    );
    for (const [name, read] of Object.entries(POOLED_METRICS)) {
      const bucket = modelAgg.pooled.get(name);
      for (const run of runs) {
        if (run.variant === "baseline") bucket.baselineValues.push(read(run));
        else if (run.variant === "card") bucket.candidateValues.push(read(run));
      }
      for (const [repeat, baselineRun] of baselineByRepeat) {
        const candidateRun = candidateByRepeat.get(repeat);
        if (!candidateRun) continue;
        const change = percentChange(read(baselineRun), read(candidateRun));
        if (change !== undefined) bucket.pairedPercentChanges.push(change);
      }
    }
  }

  const summary = { schemaVersion: 1, generatedAt: new Date().toISOString(), root, models: {} };
  for (const [model, agg] of byModel) {
    const variants = {};
    for (const [variantName, variantAgg] of agg.variants) {
      variants[variantName] = variantAgg;
    }
    const pooledMetrics = {};
    for (const [metricName, bucket] of agg.pooled) {
      pooledMetrics[metricName] = {
        baseline: distribution(bucket.baselineValues),
        card: distribution(bucket.candidateValues),
        pairedPercentChange: distribution(bucket.pairedPercentChanges),
      };
    }
    summary.models[model] = {
      instanceCount: agg.instances.size,
      ungradedCombos: agg.ungradedCombos,
      variants,
      pooledMetrics,
    };
  }

  const jsonPath = path.join(outputDir, "campaign-summary.json");
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);

  const lines = [`# Campaign summary`, "", `Generated: ${summary.generatedAt}`, ""];
  for (const [model, data] of Object.entries(summary.models)) {
    lines.push(`## ${model}`, "");
    lines.push(`${data.instanceCount} instances.`, "");
    if (data.ungradedCombos.length > 0) {
      lines.push(`**Ungraded combos (excluded from correctness, included in token/cost):** ${data.ungradedCombos.join(", ")}`, "");
    }
    lines.push("### Correctness", "", "| Variant | Runs | Resolved | Failed | Ungraded |", "| --- | ---: | ---: | ---: | ---: |");
    for (const [variantName, variantData] of Object.entries(data.variants)) {
      lines.push(
        `| ${variantName} | ${variantData.runs} | ${variantData.correctness.passed} | ${variantData.correctness.failed} | ${variantData.correctness.ungraded} |`,
      );
    }
    lines.push("", "### Token/cost (paired baseline→card % change, pooled across all instances×repeats)", "");
    lines.push("| Metric | n | Median % change | Min % change | Max % change |", "| --- | ---: | ---: | ---: | ---: |");
    for (const [metricName, metricData] of Object.entries(data.pooledMetrics)) {
      const d = metricData.pairedPercentChange;
      lines.push(
        `| ${metricName} | ${d.count} | ${d.median?.toFixed(1) ?? "n/a"}% | ${d.min?.toFixed(1) ?? "n/a"}% | ${d.max?.toFixed(1) ?? "n/a"}% |`,
      );
    }
    lines.push("", "### Absolute totals per variant", "");
    lines.push("| Metric | Variant | n | Median | Min | Max |", "| --- | --- | ---: | ---: | ---: | ---: |");
    for (const [metricName, metricData] of Object.entries(data.pooledMetrics)) {
      for (const variantKey of ["baseline", "card"]) {
        const d = metricData[variantKey];
        const fmt = (v) => (v === null || v === undefined ? "n/a" : Math.round(v).toLocaleString());
        lines.push(`| ${metricName} | ${variantKey} | ${d.count} | ${fmt(d.median)} | ${fmt(d.min)} | ${fmt(d.max)} |`);
      }
    }
    lines.push("");
  }
  const mdPath = path.join(outputDir, "campaign-summary.md");
  await writeFile(mdPath, `${lines.join("\n")}\n`);

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
