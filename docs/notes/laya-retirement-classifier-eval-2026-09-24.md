# Evidence-retirement heuristic evaluation: current heuristic vs. Laya (2026-09-24)

**Outcome: Laya rejected. The heuristic's actual failure mode (identified here) was
fixed instead — see `docs/plans/retirement-centralization-and-disuse-gating.md`.**

## Why this ran

A user report ("Pi gets stuck, I have to run it without the extension") led to
tracing a real production session
(`~/.pi/agent/sessions/--C--Users-chkri-source-repos-CoreApps--/2026-09-21T12-05-20-621Z_01a0c3db-3e6c-7550-952f-c3f475b63f46.jsonl`)
where the agent re-read the same handful of files repeatedly for 19 minutes and
never made a single edit. Root cause: `consumedByDisuse` in
`src/core/projection.ts` was dropping read evidence within 1-2 rounds based only
on "did any later text repeat this exact file path substring" — unrelated to
whether a mutation had actually happened. The user asked for "a better heuristic
or a model" after an earlier internal classifier attempt ("JVE") reportedly
failed ~half the time (no logs of that attempt exist in this repo or anywhere
findable on disk — only the conceptual "10M-parameter keep/drop classifier" in
`AGENTS.md`, which was rejected on paper and never built). The user then asked to
try `https://pypi.org/project/laya/` and record results.

## Setup

- **Ground truth** (hindsight, deterministic): a read is "needed again" if the
  exact same file path is read or mutated again later in the same session
  transcript.
- **Current heuristic**: a Python re-implementation of `consumedByDisuse` as it
  stood before the 2026-09-25 fix — retires a read once any later successful
  tool call happens (`graceObserved`) unless the exact lowercase file path
  substring reappears in later assistant text or tool-call arguments
  (`referencedAfter`).
- **Laya**: `convaiinnovations/laya` (a small, fast "System 1" calibrated
  decision model, ~421M-800MB checkpoint depending on variant, Apache 2.0, runs
  fully offline via `pip install laya`) via `Router.predict`, asked a zero-shot
  `noul` (boolean) question — "is this file's content still needed?" — given the
  task's opening request, the file path, and up to ~900 chars / 6 turns of what
  happened immediately after the read (no hindsight — same information the real
  system has at decision time).
- **Data**: 155 real read events pulled from 5 production Pi sessions in the
  CoreApps repo (3 sessions where the agent never made a single edit — "stuck" —
  and 2 where it completed real work), all using the `agent-context-card`
  extension. Reproducible from `evaluation/results/laya-disuse-eval-2026-09-24/`:
  `01-build-candidates.py` (extracts candidates + ground truth from the session
  JSONLs, writes `candidates.json`), `02-run-laya.py` (needs `pip install laya`
  in a venv — pulls the HF checkpoint on first run, ~3.5 min load + ~1.3s/example
  on CPU — writes `results.json`), `03-compute-metrics.py` (prints the tables
  below from `results.json`). Both `candidates.json` and `results.json` are
  committed as the raw record.

## Headline numbers

| | accuracy | recall (needed-again) | precision | specificity (correctly retired) |
|---|---:|---:|---:|---:|
| Current heuristic | 75.5% | 76.9% | 89.1% | 71.1% |
| Laya @ 0.5 | 68.4% | 88.0% | 74.6% | **7.9%** |

Laya's specificity of 7.9% means: of the 38 reads that genuinely became
irrelevant, Laya said "still needed" for 35 of them. It essentially never
recommends retiring anything.

## Calibration check — the key finding

| | avg Laya probability |
|---|---:|
| Ground truth = needed again (n=117) | 0.613 |
| Ground truth = not needed again (n=38) | 0.619 |

**These are statistically indistinguishable.** Laya's output does not track the
actual label at all in this zero-shot setup — it hovers around ~0.6 regardless
of whether the file was truly needed again. The apparent recall/accuracy numbers
above are an artifact of the dataset's class imbalance (117/155 = 75% positive)
combined with Laya's constant upward bias, not genuine discrimination.

A threshold sweep confirms this: every threshold from 0.3-0.7 just trades
recall for specificity along the same curve you'd get from a biased coin —
there's no threshold where both are good simultaneously (0.3 → 99% recall /
0% specificity; 0.7 → 20% recall / 76% specificity).

Same file read twice in very similar context two rounds apart, in the same
session, got Laya probabilities of 0.294 and 0.584 — a ~0.3 swing on what
should be nearly the same judgment. This is noise, not signal.

## Where the current heuristic actually breaks

Per-session accuracy tells the real story:

| session | reads | heuristic acc | laya acc |
|---|---:|---:|---:|
| 2026-09-14T15-24-30 (stuck, 0 edits) | 24 | **8%** | 83% |
| 2026-09-14T15-11-30 (stuck, 0 edits) | 8 | **38%** | 75% |
| 2026-09-21T12-05-20 (stuck, 0 edits — the session first analyzed) | 13 | 85% | 62% |
| 2026-09-14T09-15-36 (completed, 48 edits) | 52 | 96% | 65% |
| 2026-09-08T08-46-28 (completed, 16 edits) | 58 | 88% | 66% |

The heuristic is *not* uniformly bad — it's excellent (88-96%) in sessions where
real progress (edits) is happening, and it collapses specifically in sessions
where no mutation ever occurs. Laya's near-constant "needed" bias happens to
look good on exactly those collapsed sessions (because almost everything really
is still needed there) and looks worse everywhere else — it isn't reading the
situation, it's just defaulting to "keep," which only pays off when the true
label happens to be skewed that way.

## Conclusion

Laya, tried zero-shot with this framing, is not a usable drop-in replacement: it
doesn't discriminate the two classes at all (calibration collapse), it's noisy
on near-identical inputs, and defaulting to "keep" would reintroduce the
unbounded-context-growth problem `consumedByDisuse` was built to solve in the
first place (commit `eb9b4e7`). **Do not revisit a classifier/model-based
retirement signal without new evidence — this result plus `AGENTS.md`'s prior
rejection of the same idea are both against it.**

The one genuinely useful thing this run surfaces: heuristic failure correlates
almost perfectly with **lack of forward progress** (no mutation in the
session), not with anything about individual files. That's a deterministic,
event-driven signal already available in this codebase (a later successful
mutation, anywhere) — consistent with the project's stated philosophy of
preferring deterministic session events over model-based judgment. This was
implemented as the actual fix on 2026-09-25: see
`docs/plans/retirement-centralization-and-disuse-gating.md`.
