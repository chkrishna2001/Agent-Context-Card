import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sanitizePatch, summarizeOfficialReport } from "./swebench.mjs";

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
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

async function filesBelow(directory, name) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(full, name)));
    else if (entry.name === name) found.push(full);
  }
  return found;
}

async function run(command, args, cwd, timeoutMs) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
    });
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (data) => {
      stdout += data;
      process.stdout.write(data);
    });
    child.stderr?.on("data", (data) => {
      stderr += data;
      process.stderr.write(data);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, timedOut, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        timedOut,
        stdout,
        stderr: `${stderr}\n${String(error)}`,
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.report)
    throw new Error(
      "Usage: node scripts/evaluation/grade-swebench.mjs --report <report.json> [--python <path>]",
    );
  const reportPath = path.resolve(process.cwd(), args.report);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (!report.benchmark?.instanceId)
    throw new Error("Report has no benchmark.instanceId");
  const python = path.resolve(
    process.cwd(),
    args.python ??
      path.join(
        ".agent-context-card",
        "swebench-venv",
        "Scripts",
        "python.exe",
      ),
  );
  const wrapper = path.join(scriptDirectory, "swebench-windows.py");
  const invocationId = new Date()
    .toISOString()
    .replace(/[-:.]/g, "")
    .replace("Z", "");
  const gradeRoot = path.join(
    path.dirname(reportPath),
    "swebench-grades",
    invocationId,
  );
  await mkdir(gradeRoot, { recursive: true });
  const grades = [];

  const candidates = args.variant
    ? report.runs.filter((run) => run.variant === args.variant)
    : report.runs;
  if (candidates.length === 0)
    throw new Error(`No runs matched variant ${args.variant}`);

  for (const candidate of candidates) {
    if (!candidate.predictionPath)
      throw new Error(`Run ${candidate.name} has no prediction export`);
    const runId = safeName(
      `acc-${report.benchmark.instanceId}-${candidate.name}-${invocationId}`,
    );
    const cwd = path.join(gradeRoot, safeName(candidate.name));
    await mkdir(cwd, { recursive: true });
    const submittedPatch = sanitizePatch(candidate.modelPatch?.text ?? "");
    const predictionPath = path.join(cwd, "prediction.json");
    await writeFile(
      predictionPath,
      `${JSON.stringify(
        [
          {
            instance_id: report.benchmark.instanceId,
            model_name_or_path: safeName(
              `${report.name}-${candidate.name}-${report.model}`,
            ),
            model_patch: submittedPatch,
          },
        ],
        null,
        2,
      )}\n`,
    );
    const result = await run(
      python,
      [
        wrapper,
        "--dataset_name",
        report.benchmark.dataset ?? "SWE-bench/SWE-bench_Verified",
        "--split",
        report.benchmark.split ?? "test",
        "--instance_ids",
        report.benchmark.instanceId,
        "--predictions_path",
        predictionPath,
        "--max_workers",
        "1",
        "--timeout",
        String(report.benchmark.timeoutSeconds ?? 1800),
        "--cache_level",
        report.benchmark.cacheLevel ?? "env",
        "--clean",
        "false",
        "--run_id",
        runId,
        "--report_dir",
        cwd,
      ],
      cwd,
      (report.benchmark.timeoutSeconds ?? 1800) * 1000 + 15 * 60 * 1000,
    );
    const reports = [];
    for (const file of await filesBelow(cwd, "report.json")) {
      try {
        reports.push({ file, data: JSON.parse(await readFile(file, "utf8")) });
      } catch (error) {
        reports.push({ file, error: String(error) });
      }
    }
    const official = summarizeOfficialReport(
      reports,
      report.benchmark.instanceId,
    );
    grades.push({
      run: candidate.name,
      variant: candidate.variant,
      repeat: candidate.repeat,
      rawPredictionPath: candidate.predictionPath,
      predictionPath,
      rawPatchBytes: candidate.modelPatch?.bytes ?? 0,
      submittedPatchBytes: Buffer.byteLength(submittedPatch),
      submittedPatchSha256: createHash("sha256")
        .update(submittedPatch)
        .digest("hex"),
      process: {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      },
      official,
      reports,
    });
    if (result.exitCode !== 0 || result.timedOut || !official.completed)
      throw new Error(
        `SWE-bench grading failed for ${candidate.name} (exit ${result.exitCode}, report ${official.completed ? "found" : "missing"})`,
      );
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceReport: reportPath,
    benchmark: report.benchmark,
    grades,
  };
  const outputPath = path.join(gradeRoot, "grades.json");
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  const markdown = [
    `# SWE-bench grade: ${report.benchmark.instanceId}`,
    "",
    "| Run | Variant | Resolved | Patch applied | F2P pass/fail | P2P pass/fail | Submitted bytes |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...grades.map(
      (grade) =>
        `| ${grade.run} | ${grade.variant} | ${grade.official.resolved ? "yes" : "no"} | ${grade.official.patchApplied ? "yes" : "no"} | ${grade.official.failToPass.success}/${grade.official.failToPass.failure} | ${grade.official.passToPass.success}/${grade.official.passToPass.failure} | ${grade.submittedPatchBytes} |`,
    ),
    "",
  ].join("\n");
  await writeFile(path.join(gradeRoot, "grades.md"), markdown);
  process.stdout.write(`\n${outputPath}\n`);
}

await main();
