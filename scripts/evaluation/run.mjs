import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  aggregateTurns,
  analyzeSession,
  analyzeTrace,
  percentChange,
  summarizeAudits,
  summarizeRepeatedRuns,
} from "./metrics.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");

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

async function runProcess(command, args, options = {}) {
  const started = performance.now();
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      windowsHide: true,
    });
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forcedResolutionTimer;
    const stdoutStream = options.stdoutFile
      ? createWriteStream(options.stdoutFile)
      : undefined;
    const stderrStream = options.stderrFile
      ? createWriteStream(options.stderrFile)
      : undefined;
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      stdoutStream?.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      stderrStream?.write(chunk);
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forcedResolutionTimer) clearTimeout(forcedResolutionTimer);
      stdoutStream?.end();
      stderrStream?.end();
      resolve(result);
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        if (process.platform === "win32" && child.pid) {
          const killer = spawn(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true },
          );
          killer.stdin?.end();
        } else {
          child.kill("SIGKILL");
        }
        forcedResolutionTimer = setTimeout(
          () =>
            finish({
              exitCode: -1,
              signal: "timeout",
              stdout,
              stderr,
              durationMs: performance.now() - started,
              timedOut,
            }),
          10_000,
        );
      },
      options.timeoutMs ?? 15 * 60 * 1_000,
    );
    child.on("error", (error) => {
      finish({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${String(error)}`.trim(),
        durationMs: performance.now() - started,
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        exitCode: code ?? -1,
        signal,
        stdout,
        stderr,
        durationMs: performance.now() - started,
        timedOut,
      });
    });
  });
}

async function filesBelow(directory, suffix) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(full, suffix)));
    else if (!suffix || entry.name.endsWith(suffix)) found.push(full);
  }
  return found;
}

async function workspaceSnapshot(directory) {
  const files = await filesBelow(directory);
  const result = {};
  for (const file of files) {
    const relative = path.relative(directory, file).replaceAll("\\", "/");
    if (
      relative.startsWith(".git/") ||
      relative.startsWith(".agent-context-card/") ||
      relative.startsWith("node_modules/")
    )
      continue;
    const data = await readFile(file);
    result[relative] = {
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  }
  return result;
}

async function captureGitPatch(workspace) {
  const intent = await runProcess(
    "git",
    ["add", "--intent-to-add", "--all", "--"],
    {
      cwd: workspace,
      timeoutMs: 30_000,
    },
  );
  if (intent.exitCode !== 0)
    return {
      text: "",
      bytes: 0,
      sha256: undefined,
      error: intent.stderr || "git add --intent-to-add failed",
    };
  const diff = await runProcess(
    "git",
    [
      "diff",
      "--binary",
      "--no-ext-diff",
      "HEAD",
      "--",
      ".",
      ":(exclude).agent-context-card/**",
    ],
    {
      cwd: workspace,
      timeoutMs: 30_000,
    },
  );
  if (diff.exitCode !== 0)
    return {
      text: "",
      bytes: 0,
      sha256: undefined,
      error: diff.stderr || "git diff failed",
    };
  return {
    text: diff.stdout,
    bytes: Buffer.byteLength(diff.stdout),
    sha256: createHash("sha256").update(diff.stdout).digest("hex"),
  };
}

function compareSnapshots(before, after) {
  const beforeNames = new Set(Object.keys(before));
  const afterNames = new Set(Object.keys(after));
  return {
    added: [...afterNames].filter((name) => !beforeNames.has(name)).sort(),
    deleted: [...beforeNames].filter((name) => !afterNames.has(name)).sort(),
    changed: [...afterNames]
      .filter(
        (name) =>
          beforeNames.has(name) && before[name].sha256 !== after[name].sha256,
      )
      .sort(),
  };
}

async function prepareWorkspace(spec, destination) {
  if (spec.type === "copy") {
    const source = path.resolve(repositoryRoot, spec.source);
    await cp(source, destination, { recursive: true, errorOnExist: true });
    return;
  }
  if (spec.type === "git") {
    let source = spec.source;
    if (spec.cache) {
      const cache = path.resolve(repositoryRoot, spec.cache);
      try {
        await access(cache);
      } catch {
        await mkdir(path.dirname(cache), { recursive: true });
        const mirror = await runProcess(
          "git",
          ["clone", "--mirror", spec.source, cache],
          { cwd: repositoryRoot, timeoutMs: spec.timeoutMs },
        );
        if (mirror.exitCode !== 0)
          throw new Error(`git mirror clone failed: ${mirror.stderr}`);
      }
      source = cache;
    }
    const clone = await runProcess(
      "git",
      ["clone", "--no-hardlinks", source, destination],
      { cwd: repositoryRoot, timeoutMs: spec.timeoutMs },
    );
    if (clone.exitCode !== 0)
      throw new Error(`git clone failed: ${clone.stderr}`);
    if (spec.commit) {
      const checkout = await runProcess(
        "git",
        ["checkout", "--detach", spec.commit],
        {
          cwd: destination,
        },
      );
      if (checkout.exitCode !== 0)
        throw new Error(`git checkout failed: ${checkout.stderr}`);
    }
    return;
  }
  throw new Error(`Unsupported workspace type: ${spec.type}`);
}

async function readTaskSnapshots(workspace) {
  const directory = path.join(workspace, ".agent-context-card", "tasks");
  const snapshots = [];
  for (const file of await filesBelow(directory, ".json")) {
    try {
      snapshots.push({ file, data: JSON.parse(await readFile(file, "utf8")) });
    } catch (error) {
      snapshots.push({ file, error: String(error) });
    }
  }
  return snapshots;
}

function continuityAssertions(expectation, sessions, snapshots) {
  const assertions = [];
  if (!expectation) return assertions;
  const projections = sessions.flatMap((session) => session.projections);
  const taskState = sessions.flatMap((session) => session.taskState);
  const firstProjection = projections[0];
  const taskSnapshot = snapshots.find(
    (snapshot) => snapshot.data?.taskId === expectation.taskId,
  );
  const add = (name, pass, detail) => assertions.push({ name, pass, detail });

  if (expectation.taskId)
    add(
      "task ID projected",
      projections.some(
        (audit) => audit?.continuity?.taskId === expectation.taskId,
      ),
      expectation.taskId,
    );
  if (expectation.resume !== undefined)
    add(
      expectation.resume ? "snapshot resumed" : "snapshot not resumed",
      taskState.some(
        (audit) => audit.operation === "load" && audit.status === "success",
      ) === expectation.resume,
      JSON.stringify(taskState),
    );
  if (expectation.zeroHotEvidence)
    add(
      "zero cross-session evidence leases",
      Array.isArray(firstProjection?.hotEvidence) &&
        firstProjection.hotEvidence.length === 0,
      JSON.stringify(firstProjection?.hotEvidence),
    );
  if (expectation.planRevision !== undefined)
    add(
      `plan revision ${expectation.planRevision}`,
      projections.some(
        (audit) => audit?.continuity?.planRevision === expectation.planRevision,
      ),
      JSON.stringify(projections.map((audit) => audit?.continuity)),
    );
  if (expectation.noPlan)
    add(
      "no prior plan inherited",
      projections.every((audit) => !audit?.continuity?.planRevision),
      JSON.stringify(projections.map((audit) => audit?.continuity)),
    );
  if (expectation.snapshotPlanContains)
    add(
      "snapshot contains exact plan marker",
      taskSnapshot?.data?.plan?.content?.includes(
        expectation.snapshotPlanContains,
      ) === true ||
        taskSnapshot?.data?.candidate?.content?.includes(
          expectation.snapshotPlanContains,
        ) === true,
      taskSnapshot?.data?.plan?.content ??
        taskSnapshot?.data?.candidate?.content,
    );
  return assertions;
}

async function validateWorkspace(workspace, validations = [], assertions = []) {
  const commands = [];
  for (const validation of validations) {
    const result = await runProcess(validation.command, [], {
      cwd: workspace,
      shell: true,
      timeoutMs: validation.timeoutMs,
      env: process.env,
    });
    commands.push({
      ...validation,
      ...result,
      pass: result.exitCode === (validation.expectedExitCode ?? 0),
    });
  }
  const files = [];
  for (const assertion of assertions) {
    const target = path.join(workspace, assertion.path);
    let text;
    try {
      text = await readFile(target, "utf8");
    } catch {
      text = undefined;
    }
    const pass =
      (assertion.exists === undefined ||
        assertion.exists === (text !== undefined)) &&
      (!assertion.contains || text?.includes(assertion.contains)) &&
      (!assertion.notContains || !text?.includes(assertion.notContains));
    files.push({ ...assertion, pass, observedBytes: text?.length });
  }
  return {
    commands,
    files,
    pass:
      commands.every((item) => item.pass) && files.every((item) => item.pass),
  };
}

function formatDistribution(value, suffix = "") {
  if (!value || value.count === 0) return "n/a";
  const format = (number) => `${Number(number.toFixed(1))}${suffix}`;
  return `${format(value.median)} (${format(value.min)} to ${format(value.max)})`;
}

function markdownReport(report) {
  const lines = [
    `# ${report.name}`,
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "| Variant | Correct | Requests | Provider input | Output | Cache read | Cache write | Cost | Tools | Tool errors | Provider errors | Raw repeats | Same-state repeats | Duration |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const run of report.runs) {
    const metric = run.aggregate;
    lines.push(
      `| ${run.name} | ${run.correct === undefined ? "ungraded" : run.correct ? "yes" : "no"} | ${metric.providerRequests} | ${metric.usage.providerInput} | ${metric.usage.output} | ${metric.usage.cacheRead} | ${metric.usage.cacheWrite} | $${metric.usage.cost.total.toFixed(6)} | ${metric.toolCalls} | ${metric.toolErrors} | ${metric.providerErrors} | ${metric.duplicateToolCalls} | ${metric.sameStateDuplicateToolCalls} | ${(metric.durationMs / 1000).toFixed(2)}s |`,
    );
  }
  lines.push("", "## Per-turn metrics", "");
  for (const run of report.runs) {
    lines.push(
      `### ${run.name}`,
      "",
      "| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const turn of run.turns)
      lines.push(
        `| ${turn.name} | ${turn.trace.providerRequests} | ${turn.trace.usage.providerInput} | ${turn.trace.usage.output} | ${turn.trace.toolCalls} | ${turn.trace.toolErrors} | ${turn.trace.providerErrors} | ${(turn.trace.durationMs / 1000).toFixed(2)}s | ${turn.audit.maxCardChars || "—"} | ${turn.audit.maxEstimatedProjectedTokens || "—"} | ${turn.audit.maxHotEvidence || 0} | ${turn.audit.planRevisions.join(", ") || "—"} |`,
      );
    lines.push("");
  }
  if (report.repeatSummary) {
    lines.push("", "## Repeated-run distributions", "");
    for (const [variant, summary] of Object.entries(
      report.repeatSummary.variants,
    ))
      lines.push(
        `- ${variant}: ${summary.correctness.passed}/${summary.runs} correct`,
      );
    lines.push(
      "",
      "Medians are followed by the observed minimum-to-maximum range.",
      "",
      "| Metric | Baseline | Context card | Paired card change |",
      "| --- | ---: | ---: | ---: |",
    );
    const labels = {
      providerInputTokens: "Provider input tokens",
      totalTokens: "Total tokens",
      outputTokens: "Output tokens",
      reasoningTokens: "Reasoning tokens",
      cacheReadTokens: "Cache-read tokens",
      providerRequests: "Provider requests",
      toolCalls: "Tool calls",
      toolErrors: "Tool errors",
      rawRepeatedSignatures: "Raw repeated signatures",
      sameStateRepeatedSignatures: "Same-state repeated signatures",
      durationMs: "Duration (ms)",
    };
    for (const [name, label] of Object.entries(labels))
      lines.push(
        `| ${label} | ${formatDistribution(report.repeatSummary.variants.baseline?.metrics[name])} | ${formatDistribution(report.repeatSummary.variants.card?.metrics[name])} | ${formatDistribution(report.repeatSummary.pairedChanges[name], "%")} |`,
      );
    lines.push("");
  }
  if (report.comparison) {
    lines.push("", "## Card change from baseline", "");
    for (const [name, value] of Object.entries(report.comparison))
      lines.push(
        `- ${name}: ${value === undefined ? "n/a" : `${value.toFixed(1)}%`}`,
      );
  }
  lines.push("", "## Assertions", "");
  for (const run of report.runs) {
    lines.push(`### ${run.name}`, "");
    for (const turn of run.turns)
      for (const assertion of turn.assertions)
        lines.push(
          `- ${assertion.pass ? "PASS" : "FAIL"}: turn ${turn.index + 1} — ${assertion.name}`,
        );
    for (const command of run.validation.commands)
      lines.push(
        `- ${command.pass ? "PASS" : "FAIL"}: validation \`${command.command}\``,
      );
    for (const file of run.validation.files)
      lines.push(
        `- ${file.pass ? "PASS" : "FAIL"}: file assertion \`${file.path}\``,
      );
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config)
    throw new Error(
      "Usage: node scripts/evaluation/run.mjs --config <file> [--model provider/model] [--output <dir>] [--repeats n] [--variant name] [--repeat-start n]",
    );
  const configPath = path.resolve(process.cwd(), args.config);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const model = args.model ?? config.model;
  if (!model) throw new Error("A model is required in config or --model");
  if (!Array.isArray(config.turns) || config.turns.length === 0)
    throw new Error("Config must contain at least one turn");

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const shortName = safeName(config.name).slice(0, 16);
  const outputRoot = path.resolve(
    process.cwd(),
    args.output ??
      path.join(".agent-context-card", "e", `${stamp}-${shortName}`),
  );
  await mkdir(outputRoot, { recursive: true });
  const configuredVariants = config.variants ?? [
    { name: "baseline", extension: false, sessionMode: "fresh" },
    { name: "card", extension: true, sessionMode: "fresh" },
  ];
  const variants = args.variant
    ? configuredVariants.filter((variant) => variant.name === args.variant)
    : configuredVariants;
  if (variants.length === 0)
    throw new Error(`Unknown variant: ${String(args.variant)}`);
  const repeats = Number(args.repeats ?? config.repeats ?? 1);
  const repeatStart = Number(args["repeat-start"] ?? 1);
  if (!Number.isInteger(repeats) || repeats < 1)
    throw new Error("Repeats must be a positive integer");
  if (!Number.isInteger(repeatStart) || repeatStart < 1)
    throw new Error("Repeat start must be a positive integer");
  const piCli = path.resolve(
    repositoryRoot,
    config.piCli ?? "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  );
  const extensionPath = path.resolve(
    repositoryRoot,
    config.extension ?? "index.ts",
  );
  const runs = [];

  for (const [variantIndex, variant] of variants.entries()) {
    for (let offset = 0; offset < repeats; offset++) {
      const repeat = repeatStart + offset;
      const name =
        repeats > 1 || repeatStart > 1
          ? `${variant.name}-r${repeat}`
          : variant.name;
      const variantRoot = path.join(
        outputRoot,
        `r${variantIndex + 1}-${repeat}`,
      );
      const workspace = path.join(variantRoot, "w");
      const sessionDirectory = path.join(variantRoot, "s");
      const agentDirectory = config.isolateAgentDirectory
        ? path.join(variantRoot, "a")
        : undefined;
      const traceDirectory = path.join(variantRoot, "t");
      await mkdir(traceDirectory, { recursive: true });
      await mkdir(sessionDirectory, { recursive: true });
      if (agentDirectory) await mkdir(agentDirectory, { recursive: true });
      await prepareWorkspace(config.workspace, workspace);
      const before = await workspaceSnapshot(workspace);
      const turns = [];
      const sessionOffsets = new Map();
      let continuedSessionFile;

      for (let index = 0; index < config.turns.length; index++) {
        const turn = config.turns[index];
        const stem = `${String(index + 1).padStart(2, "0")}-${safeName(turn.name ?? `turn-${index + 1}`)}`;
        const stdoutFile = path.join(traceDirectory, `${stem}.jsonl`);
        const stderrFile = path.join(traceDirectory, `${stem}.stderr.log`);
        const cliArgs = [
          piCli,
          "--mode",
          "json",
          "--print",
          "--session-dir",
          sessionDirectory,
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--approve",
          "--model",
          model,
          "--thinking",
          config.thinking ?? "off",
        ];
        if (variant.sessionMode === "continue" && continuedSessionFile)
          cliArgs.push("--session", continuedSessionFile);
        if (config.offlineStartup !== false) cliArgs.push("--offline");
        if (config.noContextFiles) cliArgs.push("--no-context-files");
        if (variant.extension) cliArgs.push("--extension", extensionPath);
        if (Array.isArray(config.tools))
          cliArgs.push("--tools", config.tools.join(","));
        cliArgs.push(turn.prompt);
        const childEnvironment = {
          ...process.env,
          PI_TELEMETRY: "0",
        };
        if (agentDirectory)
          childEnvironment.PI_CODING_AGENT_DIR = agentDirectory;
        const result = await runProcess(process.execPath, cliArgs, {
          cwd: workspace,
          timeoutMs: turn.timeoutMs ?? config.timeoutMs,
          env: childEnvironment,
          stdoutFile,
          stderrFile,
        });
        await writeFile(stdoutFile, result.stdout);
        await writeFile(stderrFile, result.stderr);
        const sessionPaths = await filesBelow(sessionDirectory, ".jsonl");
        if (variant.sessionMode === "continue" && !continuedSessionFile)
          continuedSessionFile = sessionPaths[0];
        const sessions = [];
        for (const file of sessionPaths) {
          const data = await readFile(file);
          const offset = sessionOffsets.get(file) ?? 0;
          if (data.length <= offset) continue;
          sessions.push({
            file,
            ...analyzeSession(data.subarray(offset).toString("utf8")),
          });
          sessionOffsets.set(file, data.length);
        }
        const snapshots = await readTaskSnapshots(workspace);
        const turnResult = {
          index,
          name: turn.name ?? `turn-${index + 1}`,
          prompt: turn.prompt,
          process: {
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            stderrBytes: Buffer.byteLength(result.stderr),
          },
          trace: analyzeTrace(result.stdout, result.durationMs),
          audit: summarizeAudits(sessions),
          sessions,
          snapshots,
          assertions: variant.extension
            ? continuityAssertions(turn.expect, sessions, snapshots)
            : [],
        };
        turns.push(turnResult);
        await writeFile(
          path.join(variantRoot, `${stem}.result.json`),
          `${JSON.stringify(turnResult, null, 2)}\n`,
        );
        if (
          result.exitCode !== 0 ||
          result.timedOut ||
          turnResult.trace.providerErrors > 0 ||
          turnResult.trace.jsonErrors.length > 0
        )
          break;
      }

      const validation = await validateWorkspace(
        workspace,
        config.validation,
        config.fileAssertions,
      );
      const modelPatch = await captureGitPatch(workspace);
      let predictionPath;
      if (config.benchmark?.instanceId) {
        predictionPath = path.join(variantRoot, "prediction.json");
        await writeFile(
          predictionPath,
          `${JSON.stringify(
            [
              {
                instance_id: config.benchmark.instanceId,
                model_name_or_path: safeName(`${config.name}-${name}-${model}`),
                model_patch: modelPatch.text,
              },
            ],
            null,
            2,
          )}\n`,
        );
      }
      const after = await workspaceSnapshot(workspace);
      const aggregate = aggregateTurns(turns);
      const assertionsPass = turns.every(
        (turn) =>
          turn.process.exitCode === 0 &&
          !turn.process.timedOut &&
          turn.trace.providerErrors === 0 &&
          turn.trace.jsonErrors.length === 0 &&
          turn.assertions.every((assertion) => assertion.pass),
      );
      const hasCorrectnessChecks =
        validation.commands.length > 0 || validation.files.length > 0;
      const runRecord = {
        name,
        variant: variant.name,
        repeat,
        extension: Boolean(variant.extension),
        sessionMode: variant.sessionMode,
        model,
        workspace,
        turns,
        aggregate,
        validation,
        modelPatch,
        predictionPath,
        workspaceChanges: compareSnapshots(before, after),
        runOk: assertionsPass,
        correct: hasCorrectnessChecks
          ? validation.pass && assertionsPass
          : undefined,
      };
      runs.push(runRecord);
      await writeFile(
        path.join(variantRoot, "run.json"),
        `${JSON.stringify(runRecord, null, 2)}\n`,
      );
    }
  }

  const baseline = runs.find((run) => run.variant === "baseline");
  const card = runs.find((run) => run.variant === "card");
  const repeatSummary = repeats > 1 ? summarizeRepeatedRuns(runs) : undefined;
  const comparison =
    repeats === 1 && baseline && card
      ? {
          providerInput: percentChange(
            baseline.aggregate.usage.providerInput,
            card.aggregate.usage.providerInput,
          ),
          output: percentChange(
            baseline.aggregate.usage.output,
            card.aggregate.usage.output,
          ),
          cost: percentChange(
            baseline.aggregate.usage.cost.total,
            card.aggregate.usage.cost.total,
          ),
          requests: percentChange(
            baseline.aggregate.providerRequests,
            card.aggregate.providerRequests,
          ),
          toolCalls: percentChange(
            baseline.aggregate.toolCalls,
            card.aggregate.toolCalls,
          ),
          rawRepeatedSignatures: percentChange(
            baseline.aggregate.duplicateToolCalls,
            card.aggregate.duplicateToolCalls,
          ),
          sameStateRepeatedSignatures: percentChange(
            baseline.aggregate.sameStateDuplicateToolCalls,
            card.aggregate.sameStateDuplicateToolCalls,
          ),
          duration: percentChange(
            baseline.aggregate.durationMs,
            card.aggregate.durationMs,
          ),
        }
      : undefined;
  const report = {
    schemaVersion: 1,
    name: config.name,
    generatedAt: new Date().toISOString(),
    configPath,
    model,
    thinking: config.thinking ?? "off",
    outputRoot,
    benchmark: config.benchmark,
    runs,
    comparison,
    repeatSummary,
  };
  await writeFile(
    path.join(outputRoot, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(path.join(outputRoot, "report.md"), markdownReport(report));
  process.stdout.write(`${path.join(outputRoot, "report.md")}\n`);
  if (runs.some((run) => !run.correct)) process.exitCode = 1;
}

await main();
