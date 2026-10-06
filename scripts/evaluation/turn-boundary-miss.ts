// For each user turn in recorded card sessions, rebuilds the last request of
// the previous turn and the first request of this turn the way the Pi
// adapter sends them (turn-pinned projection + raw tail, status after the
// turn's user request), then reports where the first changed message sits:
//   window   - the first history message changed: an old turn left the window
//   retired  - a retirement changed history before the previous turn's request
//   status   - only the previous turn's status block was dropped
// and how many characters follow the change (what the provider must recompute).
// Run: bun scripts/evaluation/turn-boundary-miss.ts <session.jsonl>...
import { readFileSync } from "node:fs";
import { projectContext } from "../../src/core/projection";
import { normalizeMessages } from "../../src/pi/normalize";

const STATUS = { status: true };
type Wire = unknown;

function load(file: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message)
        messages.push(entry.message);
    } catch {
      /* skip */
    }
  }
  return messages;
}

function wire(projected: unknown[]): Wire[] {
  const index = projected.findLastIndex((m: any) => m.role === "user");
  return [
    ...projected.slice(0, index + 1),
    STATUS,
    ...projected.slice(index + 1),
  ];
}

const size = (m: unknown) => (m === STATUS ? 0 : JSON.stringify(m).length);

const totals: Record<string, number> = {};
for (const file of process.argv.slice(2)) {
  const messages = load(file);
  const users = messages
    .map((m: any, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0);
  for (let t = 1; t < users.length; t++) {
    const prevStart = users[t - 1];
    const start = users[t];
    // Previous turn: pinned at its first request, plus its raw tail.
    const pinPrev = projectContext(
      normalizeMessages(messages.slice(0, prevStart + 1) as never[]),
    ).messages;
    const last = wire([...pinPrev, ...messages.slice(prevStart + 1, start)]);
    const first = wire(
      projectContext(normalizeMessages(messages.slice(0, start + 1) as never[]))
        .messages,
    );
    let k = 0;
    while (
      k < last.length &&
      k < first.length &&
      (last[k] === first[k] ||
        (last[k] !== STATUS &&
          first[k] !== STATUS &&
          JSON.stringify(last[k]) === JSON.stringify(first[k])))
    )
      k++;
    const prevUserPos = last.findLastIndex(
      (m: any) => m !== STATUS && m.role === "user",
    );
    const kind = k === 0 ? "window" : k > prevUserPos ? "status" : "retired";
    const recompute = first.slice(k).reduce((s: number, m) => s + size(m), 0);
    totals[kind] = (totals[kind] ?? 0) + 1;
    totals[`${kind}Chars`] = (totals[`${kind}Chars`] ?? 0) + recompute;
    console.log(
      `${file.split(/[\/]/).slice(-3, -2)[0]} turn ${t + 1}: ${kind} at ${k}/${first.length}, recompute ${recompute} chars`,
    );
  }
}
console.log(JSON.stringify(totals));
