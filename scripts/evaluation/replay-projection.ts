// Replays recorded Pi sessions through the real projectContext and reports
// how many characters each request would carry (summed over every Nth
// prefix, a proxy for per-request provider input) plus retirement counts.
// Run before/after a retirement-rule change (git stash) to isolate its
// effect: bun scripts/evaluation/replay-projection.ts [sessions_dir] [step]
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectContext } from "../../src/core/projection";
import { normalizeMessages } from "../../src/pi/normalize";

const dir =
  process.argv[2] ??
  join(
    homedir(),
    ".pi/agent/sessions/--C--Users-chkri-source-repos-CoreApps--",
  );
const step = Number(process.argv[3] ?? 10);

let totalOriginal = 0;
let totalProjected = 0;
let rows = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
  const messages: unknown[] = [];
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message) {
        messages.push(entry.message);
      }
    } catch {
      /* skip malformed line */
    }
  }
  if (messages.length < 20) continue;
  const normalized = normalizeMessages(messages as never[]);
  let original = 0;
  let projected = 0;
  let superseded = 0;
  for (let end = step; end <= normalized.length; end += step) {
    const result = projectContext(normalized.slice(0, end));
    original += result.originalChars;
    projected += result.projectedChars;
    superseded += result.retired.superseded ?? 0;
  }
  totalOriginal += original;
  totalProjected += projected;
  rows++;
  console.log(
    `${file.slice(0, 24)} msgs=${normalized.length} projected/original=${projected}/${original} superseded=${superseded}`,
  );
}
console.log(
  `TOTAL sessions=${rows} projected=${totalProjected} original=${totalOriginal}`,
);
