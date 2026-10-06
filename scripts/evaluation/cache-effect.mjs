// Re-prices paired baseline/card runs with provider-reported prompt-cache
// usage, because raw provider input treats a cache-read token the same as an
// uncached one. On caching providers the card's lower raw input can still
// cost more: retirement and per-turn card changes break the cacheable prefix.
//
//   node scripts/evaluation/cache-effect.mjs <report.json>... [--cached 0.1]
//
// Effective input = uncached + cached * cacheRead + write * cacheWrite, with
// write = 1.25 for anthropic/* (5-minute cache write premium) and 1 otherwise.
// Runs pair by name suffix (baseline-r2 <-> card-r2, baseline <-> card).
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const cachedAt = args.indexOf("--cached");
const cached = cachedAt >= 0 ? Number(args[cachedAt + 1]) : 0.1;
const reports = args.filter(
  (_, index) => cachedAt < 0 || (index !== cachedAt && index !== cachedAt + 1),
);
if (!reports.length || !Number.isFinite(cached)) {
  console.error(
    "usage: cache-effect.mjs <report.json>... [--cached <price ratio>]",
  );
  process.exit(1);
}

function usageOf(run) {
  const usage = run.aggregate?.usage ?? {};
  const write = String(run.model ?? "").startsWith("anthropic/") ? 1.25 : 1;
  const input = usage.input ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return {
    raw: input + cacheRead + cacheWrite,
    uncached: input + cacheWrite,
    hit: cacheRead / Math.max(1, input + cacheRead + cacheWrite),
    effective: input + cached * cacheRead + write * cacheWrite,
  };
}

const change = (card, baseline) =>
  baseline ? `${(((card - baseline) / baseline) * 100).toFixed(1)}%` : "n/a";

console.log(
  `cached-token price ratio ${cached}\n` +
    "| Report | Pair | Model | Hit base | Hit card | Raw Δ | Uncached Δ | Effective Δ |\n" +
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
);
for (const file of reports) {
  const report = JSON.parse(await readFile(file, "utf8"));
  const runs = new Map((report.runs ?? []).map((run) => [run.name, run]));
  for (const [name, card] of runs) {
    const suffix = name.match(/^(?:.*-)?card(.*)$/)?.[1];
    if (suffix === undefined) continue;
    const baseline = runs.get(name.replace(/card/, "baseline"));
    if (!baseline) continue;
    const b = usageOf(baseline);
    const c = usageOf(card);
    console.log(
      `| ${file.replace(/[\\/]report\.json$/, "")} | ${name} | ${card.model} | ${(b.hit * 100).toFixed(0)}% | ${(c.hit * 100).toFixed(0)}% | ${change(c.raw, b.raw)} | ${change(c.uncached, b.uncached)} | ${change(c.effective, b.effective)} |`,
    );
  }
}
