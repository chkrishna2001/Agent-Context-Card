# Working notes — 2026-09-14

Captured mid-session so a future agent (or me, later) doesn't have to re-derive
this from scratch. Not a decision record — see AGENTS.md for the curated,
evidence-gated claims once this has real results attached. This file is the
raw trail: what was found, what shipped, what's still open, where the last
test run stands.

## Where this started

User pointed at two real Pi session logs from a CoreApps session the day
before (not this repo's own sessions — a consumer project with
agent-context-card installed as an extension):

- `C:\Users\chkri\.pi\agent\sessions\--C--Users-chkri-source-repos-CoreApps--\2026-09-14T15-11-30-828Z_01a0a079-2c0c-7468-bbac-8662d4bef8fd.jsonl`
- `C:\Users\chkri\.pi\agent\sessions\--C--Users-chkri-source-repos-CoreApps--\2026-09-14T15-27-18-903Z_01a0a087-a377-711e-aeed-6968af6aef18.jsonl`

Symptom: "tool call is being rejected and model keeps calling same tool."
Model backend in both: `ai-inference-router/mycoder`.

Analyzed both with DuckDB directly against the `.jsonl` session logs (per
global CLAUDE.md: DuckDB for JSON/JSONL, narrow queries, never load raw
transcripts into context). Key query pattern that worked reliably —
`read_ndjson_objects()` plus a CTE that isolates one field per row before any
second `->>`/`json_each` chain, since combining two json-path expressions
across rows with heterogeneous schemas in one `WHERE` throws a spurious
`Conversion Error: Failed to cast value to numerical`:

```sql
WITH rows AS (SELECT json AS j FROM read_ndjson_objects('<path>')),
msgs AS (SELECT j->>'timestamp' AS ts, j->'message'->'content' AS content
         FROM rows WHERE j->>'type' = 'message')
SELECT ts, t.value->>'text' FROM msgs, json_each(content) AS t WHERE ...
```

## What the logs showed

**Session 1** (`...15-11-30...`): model repeated an identical `read` on
`sthotraani.component.scss` — file unchanged between reads. Hard-block guard
(`HARD_BLOCK_REPEAT_THRESHOLD = 3` in `src/pi/index.ts`) engaged correctly at
the 3rd identical attempt, returned its static refusal text. Model ignored it
and retried the exact same call 7 more times (block count 3→9) before the
session was aborted.

**Session 2** (`...15-27-18...`): worse. Model tried `dir /s /b <path>`
through the `bash` tool, which runs a POSIX shell, not cmd.exe — every
backslash in the path got eaten and `/s /b` were parsed as bogus paths
(`dir: cannot access '/s'...`). Deliberately **not treated as our bug** — the
user's call: "model is sending wrong command, it should correct its command,
we cannot fix every model mistake." Hard block engaged at the 3rd identical
failure and then fired **20 more times** (count 3→22) over ~35 seconds,
still climbing when the user manually interrupted.

**What actually broke the loop**, both times: the user typed a real chat
message — _"you are again making same mistake sane tool call again and
again, what are you trying to do?"_ — and the model immediately apologized,
explained its actual goal, and picked a different action. The plugin's
existing refusal text never achieved this in either session, despite firing
8–22 times.

## Root cause

Two separate steering channels exist in `src/pi/index.ts`, and they're not
equivalent:

- `pi.sendMessage(..., {deliverAs:"steer"})` — used by the existing
  `REPEATED_FAILURE_NUDGE`/`REPEATED_SUCCESS_NUDGE` logic. Sends a _custom_
  message. Capped at `CARD_NUDGE_STREAK_CAP = 2`, and by construction that
  cap is already exhausted by the time the hard block engages (nudges fire on
  real executions; the hard block only engages once repeats stop executing
  for real).
- `pi.sendUserMessage(..., {deliverAs:"steer"})` — injects an actual
  user-turn message, "as if typed by the user" (SDK example:
  `node_modules/@earendil-works/pi-coding-agent/examples/extensions/send-user-message.ts`).
  This is what the user's manual intervention effectively was. The plugin
  never used this API before this session.

Once the hard block itself engages, it had **no cap and no escalation** — it
just returns the same static tool-result refusal forever, for as long as the
model keeps resubmitting. That's why session 2 got to 22+ with no end in
sight. This is a known, previously-flagged failure mode — see the comment at
`src/pi/index.ts` near `HARD_BLOCK_REPEAT_THRESHOLD`: a prior repeat ran 143
times before the turn timed out, which is _why_ the hard block was added in
the first place (commit `b1ebbc9`). The hard block stops wasted real
execution, but it never actually stopped the loop.

## Fix landed this session (uncommitted, in working tree)

`src/pi/index.ts`: when the hard block engages, escalate with a real
`pi.sendUserMessage` asking the model to name what it's trying to achieve and
why it expected the repeat to work — not a restatement of "you already made
this call" (explicit user instruction: "prompt should steer it properly, not
just say you already called"). Capped at `HARD_BLOCK_REFLECTION_STREAK_CAP =
2` per stuck signature so an unattended session can't manufacture fake user
turns indefinitely if even this doesn't land either. Resets whenever the
attempted call signature changes, same as the existing counters.

`tests/pi-adapter.test.ts`: added a `sendUserMessage` mock to the test
harness (didn't exist — 4 existing tests broke the moment real code started
calling it, since the mock threw `TypeError: pi.sendUserMessage is not a
function`). Extended the "third identical failing attempt" test to assert
the cap (2 messages sent across 3 blocked attempts). Added a new test
confirming a differently-signatured call in between resets the reflection
streak. All 44 tests pass (`bun test tests/pi-adapter.test.ts`).

**Not fixed, and explicitly out of scope**: the `dir`/backslash-mangling
bash-tool behavior from session 2. Per the user, that's the model's mistake
to self-correct, not something this extension should special-case.

## Pre-existing issue found, not touched

`src/pi/index.ts` had an _unrelated_ uncommitted change already in the
working tree before this session started (visible in git status at session
start: `M src/pi/index.ts`) — a `successfulCallCache` / cache-hit mechanism
(`taskAudit("cache", "hit", ...)`) that returns a cached result instead of
blocking a repeat. That call site passes `"cache"` as the audit `operation`,
which isn't in the `TaskStateAudit["operation"]` union (`"load" | "save" |
"close" | "gc" | "session" | "resume-check" | "forcing"`), so `tsc --noEmit`
fails with one error. Confirmed via `git stash` that this predates the
reflection-escalation work and isn't something I introduced. Whoever owns
that caching WIP needs to either add `"cache"` to the union or change the
audit call. Left as-is since it's someone else's in-progress change, not
something to silently absorb into an unrelated fix.

## Full validation suite (AGENTS.md's exact checklist, not just a subset)

Initially only ran `tsc --noEmit` and `bun test`. AGENTS.md's "Development
rules" section lists five commands; ran the remaining three too:

- `bun test` — 44/44 pass.
- `bun x tsc --noEmit` — one error, `taskAudit("cache", ...)`, pre-existing
  (see above), confirmed via `git stash` to predate this session.
- `bun x eslint .` — clean.
- `bun x prettier --check .` — 14 files flagged, but confirmed via
  `git stash` that `src/pi/index.ts` was **already** flagged at HEAD before
  any change this session (looks like a repo-wide CRLF/LF drift on this
  Windows checkout, not real content issues — same pattern across
  `src/core/*`, `tests/identity.test.ts`, `scripts/*`, none of which this
  session touched). My new note file was flagged too; ran
  `prettier --write` on just that file and it's now clean. Left the 14
  pre-existing files alone — not this session's change to make.
- `bun build index.ts --outdir dist --target node` — succeeds (`dist/` is
  gitignored, confirmed no git-status change from running it).

## Important correction after reading AGENTS.md in full (not just headers)

Initially only `grep`'d section headers before launching the Haiku pilot —
missed real protocol content. After reading the whole file:

**The existing gemma4:31b SWE-bench pilot numbers in AGENTS.md are flagged
stale by the project's own evidence ledger.**
`evaluation/results/evidence-ledger.json`'s top-level `methodologyCaveat`
says any result whose id starts with `swebench-sympy` (both pilots) was
produced with `sessionMode: "fresh"` (one new Pi session per turn) riding a
since-removed cross-session bridge; the checked-in configs now use
`sessionMode: "continue"` (one genuinely continuing session), and the ledger
says explicitly: _"These numbers are historical and are not reproducible by
re-running the current configs; treat them as pending re-run, not current
evidence, until re-verified."_ Confirmed via `git log -p` on
`evaluation/benchmarks/swebench-verified-sympy-18211.json`: commit `aa321a2`
("Switch remaining eval configs off the removed cross-session bridge")
changed `sessionMode` from `"fresh"` to `"continue"` on this exact file,
**after** the gemma4:31b numbers currently published in AGENTS.md were
captured. Both ledger entries are still marked `claimable: true` despite
this — that flag hasn't been corrected to match the caveat yet.

Practical effect: the Haiku run below isn't just "a new model family" — under
the config as it exists today, it's also the **first re-verification of this
exact pilot under the current session mechanism**, gemma4:31b included. That
directly closes part of the AGENTS.md "What is not proved" gap ("reliability
across additional repositories, runs, and model families") rather than just
adding a data point next to already-shaky ones. Worth flagging prominently
when this gets written up, not buried as a footnote.

**Benchmark integrity rules from the first pilot** (AGENTS.md, "Benchmark
integrity rules learned from this pilot") apply to this run too: checkpoint
every turn before the next session, terminate the full Windows subprocess
tree on timeout, exclude `.agent-context-card` state from any submitted
patch, normalize the evaluator patch to LF before Linux Docker application,
treat a missing official per-instance report as an evaluation error, and
report the official resolution plus exact FAIL_TO_PASS/PASS_TO_PASS counts —
not just run.mjs's own token/tool-call report. These are (per the same
section) implemented in the harness itself, not just documented — but
confirm they actually fired for this run before trusting the numbers, same
as the first pilot's own lesson.

**Reporting protocol, once results land**: `evaluation/results/evidence-ledger.json`
is the single machine-readable source AGENTS.md/README figures are drawn
from — `tests/evaluation.test.ts` recalculates every published percentage
from its raw counts. A real result here needs a new ledger entry (with
`claimable`, `model`, `thinking`, `correctness`, raw baseline/card metrics)
before it can honestly become an AGENTS.md table, not just prose in this
notes file. Also apply the "Provider-setting activation audit" protocol
(AGENTS.md) before trusting the `thinking: off` config value for
`anthropic/claude-haiku-4-5` — configured treatment and activated (wire)
treatment are explicitly called out as separate evidence states in this
project, distinct failure modes have already been caught doing this
(phase-aware mode configured-but-inactive; Nano's `reasoning_effort` silently
absent). Claude models generally accept extended-thinking-off without the
hard-fail GPT-5 Nano has, but that's an assumption to verify here, not to
inherit uncritically.

## Current status / last test run

**Not yet committed.** `git status` at time of writing: `M src/pi/index.ts`,
`M tests/pi-adapter.test.ts`, plus this new note file.

**Validation in progress**: running the existing SWE-bench Verified pilot
harness (`scripts/evaluation/run.mjs` +
`evaluation/benchmarks/swebench-verified-sympy-18211.json` — the same config
behind `npm run eval:swebench:pilot`, previously run against gemma4:31b per
AGENTS.md's "First SWE-bench Verified pilot" section, though see the
staleness finding above) against a **new** model family,
`anthropic/claude-haiku-4-5`, to get real evidence for/against this specific
fix and the extension generally under a model that hasn't been tried against
this repo before.

Command:

```bash
node scripts/evaluation/run.mjs \
  --config evaluation/benchmarks/swebench-verified-sympy-18211.json \
  --model anthropic/claude-haiku-4-5 \
  --output .agent-context-card/e/haiku-4-5-18211
```

Both variants (`baseline` = no extension, `card` = agent-context-card
loaded), 3 turns each (plan/implement/review), against the cached sympy repo
(`.agent-context-card/git-cache/sympy.git` — already present, no fresh
clone).

## Haiku pilot result: efficiency regression, not the clean proof expected

Ran to completion. `.agent-context-card/e/haiku-4-5-18211/report.md`.
**Correctness: ungraded both variants** — official SWE-bench grading needs
Docker to run FAIL_TO_PASS/PASS_TO_PASS, and there's no `docker` on this
machine. Cannot say resolved/unresolved without it.

The efficiency numbers went the _wrong_ way, badly:

| Metric         |  baseline |      card |  change |
| -------------- | --------: | --------: | ------: |
| Provider input | 1,426,071 | 3,873,247 | +171.6% |
| Requests       |        68 |       120 |  +76.5% |
| Tool calls     |        65 |       115 |  +76.9% |
| Cost           |     $0.29 |     $4.82 |  +1558% |

Every prior result in AGENTS.md shows the card variant using _fewer_ tokens/
requests than baseline. This is the opposite, and it's the first run using
`sessionMode: "continue"` for this pilot (see staleness finding above) — so
it's also, in a sense, the first _current-mechanism_ SWE-bench data point at
all, gemma4:31b's included.

Traced the cause with DuckDB against the raw session log
(`.agent-context-card/e/haiku-4-5-18211/r2-1/s/*.jsonl`). Card's `read` calls:
62 vs baseline's 18; `bash` calls identical (46=46). 66% of those reads hit
just two files — `sympy/solvers/inequalities.py` **27 times**,
`sympy/solvers/tests/test_inequalities.py` **14 times** — every one with a
_different_ `offset`/`limit` (values oscillating 1→675 and back), so no two
ever matched byte-for-byte. Ruled out, with code references, not guesses:

- Evidence retirement evicting the file mid-turn — traced
  `consumedReads`/`consumedByDisuse` in `src/core/projection.ts`; neither can
  fire without an intervening mutation, and this was all inside the
  read-only "plan" turn.
- The card's status text re-flagging "you already read this" in a confusing
  way — `formatCardStatus` (`src/core/format.ts:189-201`) explicitly
  _omits_ active-state files from the status block by design ("Active
  entries duplicate content already visible... only non-active entries tell
  the model something it can no longer see").
- Card/status bulk diluting attention — `cardChars` stayed flat at 510 the
  entire burst; `statusChars` topped out at 2,929 against 96,123 chars of
  raw transcript (~3%).
- The hard-block/reflection fix or the cache-hit mechanism (yesterday's
  uncommitted WIP) catching this — zero `"forcing"` audit entries in the
  whole session; only 7 of the 27 reads were even exact-signature matches,
  so the cache barely engaged either.

Conclusion at the time: no confirmed mechanism, and every concrete
hypothesis checked against actual code came up negative. Recorded honestly
as unresolved rather than spun.

## Second data point: `ai-inference-router/mycoder` (gemma4:31b), same pilot

User's call, for two good reasons: Haiku is expensive and we'd just spent
~$5 on one ungraded run; mycoder already has favorable history with this
exact repo (AGENTS.md's "Ten-session mixed proof": card beat baseline -29%
requests, -34% tool calls, -100% tool errors/duplicates), so a repeat of the
pattern there would be much cheaper evidence that this is real rather than
Haiku-specific noise.

```bash
node scripts/evaluation/run.mjs \
  --config evaluation/benchmarks/swebench-verified-sympy-18211.json \
  --model ai-inference-router/mycoder \
  --output .agent-context-card/e/mycoder-18211
```

**The pattern reproduced**, via a different tool this time:

| Metric         | baseline |      card |  change |
| -------------- | -------: | --------: | ------: |
| Provider input |  669,715 | 1,258,473 |  +87.9% |
| Requests       |       20 |        50 |   +150% |
| Tool calls     |       17 |        45 | +164.7% |
| Tool errors    |        4 |        14 |       — |

Card's `bash` calls: 39 vs baseline's 13 (3x); `read` barely moved (5 vs 3).
Almost the entire blowup is in the "plan" turn alone (card: 42 requests, 39
tools, 13 errors; baseline: 5 requests, 4 tools, 1 error). Tallying the
actual bash commands: `grep -r "def as_set" sympy/core/relational.py
sympy/core/expr.py ...` fired 5 times in 6 seconds (08:36:12–08:36:18),
mostly with slightly different trailing file lists each time — only the one
truly identical repeat (08:36:23) hit the success cache
(`agent-context-card-task-state-audit` entry: `cache hit ... grep -r "def
as_set" ...`). Same shape as Haiku's read oscillation, different tool: near-
duplicate calls varying just enough to dodge exact-signature detection.

One lead checked and explicitly ruled out as a _universal_ cause: two
`"card update forced via tool_choice"` events landed 6-11 seconds before the
mycoder grep burst started — suggestively timed, but the same check against
the Haiku session found **zero** forced-update_card events anywhere in it.
Real for mycoder, possibly, but not the shared mechanism.

## Fix landed: range-containment read detection (uncommitted, in working tree)

The shared root cause across both runs: exact-signature repeat detection
(`${toolName}:${JSON.stringify(input)}`, used by both the hard block and
the success cache) requires byte-identical arguments. Both models
independently varied their near-duplicate calls just enough to never match
twice — different `offset`/`limit` for Haiku's reads, different file lists
for mycoder's greps.

Built the fix for the `read` half of this (the `bash`/grep case needs a
different, fuzzier approach and is left as an explicitly separate, open
problem — normalizing by command verb + primary search term is riskier and
wasn't attempted here).

**User's catch that shaped the design**: keying purely on `path` (ignoring
offset/limit) would have blocked legitimate progressive reads of a large
file (lines 1-100, then 101-200, then 201-300 — never repeats, always new
territory) exactly as badly as the exact-signature version missed real
repeats. The actual signal needed is "does this read return content already
known" — i.e. range _containment_, not path identity or argument identity.

New module `src/core/intervals.ts` (pure, no Pi/host imports, matches the
`src/core` boundary rule in AGENTS.md): `mergeInterval` maintains a merged,
sorted union of half-open `[start, end)` line ranges; `isFullyCovered`
checks whether a new range is entirely inside that union, including across
multiple adjoining prior intervals.

Wired into `src/pi/index.ts`:

- `readCoverage: Map<path, Interval[]>` — union of successfully-read ranges
  per path, updated in `tool_execution_end` only when the read wasn't
  already fully covered (a below-threshold contained read that still
  executed must not reset its own streak — first version of this had that
  bug, caught before committing).
- `containedRepeatCounts` / `containedReflectionStreaks`, both keyed **per
  path**, not global — deliberate: containment isn't about the immediately
  preceding call being identical (consecutiveAttemptCount's model), it's
  cumulative per-path knowledge, so an interleaved read of a _different_
  file must not reset the original path's count. Verified with a dedicated
  test (`"a read of a different path in between does not reset..."`).
- Same `HARD_BLOCK_REPEAT_THRESHOLD` (3) and reflection-escalation
  machinery as the existing exact-signature path, reused rather than
  duplicated with a new threshold — block message is specific to
  containment ("every line this call requested has already been returned
  by an earlier read... under different offset/limit arguments"), not the
  generic "exact same call" text, since that text would be actively false
  here.

Tests: `tests/intervals.test.ts` (11 cases, pure interval-math: merge
disjoint/overlapping/adjacent/bridging ranges, degenerate ranges, full
containment across single and multiple intervals, gaps, no coverage).
`tests/pi-adapter.test.ts` +3 integration tests: overlapping-offset reads of
one file get blocked on the 4th attempt despite no two sharing exact
arguments; sequential non-overlapping chunks of a large file are never
blocked, however many; a different path interleaved in between doesn't
reset the original path's streak. Full suite: 148/148 pass
(`bun test`), `bun x tsc --noEmit` shows only the same pre-existing
`"cache"`-operation error from yesterday's separate WIP (confirmed again via
`git stash` — still not something this work touched), `bun x eslint .`
clean, `bun x prettier --check .` clean on every file this session touched,
`bun build` succeeds.

## Rerun with the range-containment fix: exposed a worse, unrelated bug

Reran the exact same mycoder pilot with the fix in place
(`.agent-context-card/e/mycoder-18211-v2/`). Not better — dramatically
worse: card went from 45 tool calls (previous mycoder run) to **490**, with
the "review" turn alone making 446 requests and running the full
`timeoutMs` (1200.12s, i.e. it was killed by the turn timeout, never
concluded naturally). Raw repeats: 462; same-state repeats: 455.

Traced with DuckDB before assuming the new fix was the cause. It wasn't:
`agent-context-card-task-state-audit` operation counts for that session were
`cache: 460`, `forcing: 6` — the loop was almost entirely `"cache"` hits,
not my new `"forcing"` containment block. Drilling into which call: **446 of
460** cache hits were the exact same `bash` command (a `python -c "..."`
verification script), spanning 09:52:38Z to 10:12:56Z — 20m18s, matching the
timeout almost exactly. Only 2 of 460 touched `read` at all, and those never
even reached my containment logic (the cache-hit check short-circuits
before it).

**Root cause: a second, more severe gap in the pre-existing
`successfulCallCache` mechanism** (yesterday's separate uncommitted WIP,
same one with the untyped `"cache"` audit operation noted above). Its own
comment states the intent plainly: "break block loops by providing the
cached result instead of refusing the call when it repeats." But as
implemented it had **no cap at all** — once a signature succeeded once,
every future identical repeat was served from cache forever, silently,
returning a normal-looking success with no error and no refusal. That's
worse than the plain hard block it was meant to soften: the hard block at
least gives the model a negative signal it can react to; the cache gives it
a positive one every time, so the model has no reason to ever stop. This
predates today's work entirely and would have produced the same failure
with or without the range-containment fix — it just happened to be this
run, on this exact verification command, that triggered it at scale.

**Fix**: `src/pi/index.ts` — the cache-hit check is now gated on
`consecutiveAttemptCount < HARD_BLOCK_REPEAT_THRESHOLD`. Below the
threshold, caching still avoids a real re-execution for legitimate quick
repeats (unchanged from before). At or past it, the cache is skipped
entirely and the call falls through to the existing block-and-reflect path,
same as any other stuck exact repeat — no new state, no new constant, just
reordering so the threshold check isn't bypassable. New test:
`"the success cache stops bypassing the hard block once the repeat
threshold is reached"` in `tests/pi-adapter.test.ts` — asserts a cache hit
on attempt 2 (below threshold), then blocks on attempts 3 and 4, and that
exactly one `"cache"` audit entry was ever recorded. Also fixed a
type-checking gap this surfaced: the test harness's `toolCall()` return type
didn't include `result`, so nothing had ever type-checked a cache-hit
return value before. Full suite: 149/149 pass, `tsc`/`eslint`/`prettier`
clean (still only the one pre-existing `"cache"` operation-string error,
now at a shifted line number, confirmed unchanged in kind).

## Current status

**Not yet committed.** `git status`: `M src/pi/index.ts`,
`M tests/pi-adapter.test.ts`, plus new files
`docs/notes/hard-block-reflection-escalation-2026-09-14.md`,
`src/core/intervals.ts`, `tests/intervals.test.ts`.

**Rerun confirmed the fix.** Card went from 490 tool calls / 20-minute
timeout (v2) to 25 tool calls, no timeout, -14.9% provider input vs baseline
(v3). Only 1 cache hit in that whole run (correctly below-threshold, served
once, no runaway) and 2 unrelated activity-forced `update_card` events - the
cache-cap and containment fixes never even needed to engage, which is itself
evidence they didn't regress anything.

## 2026-09-15: n=3 repeats, a correction, and three follow-on tasks

Session carried past midnight; continuing in this same file rather than
splitting it.

**User pushed back on -14.9% as weak evidence** (correctly - every
historical number in AGENTS.md is -47% to -79%). Ran 3 repeats of each
variant (`--repeats 3`) on the same pilot/model instead of trusting one
pair. Result: median provider-input change is **-60.5%** (range -74.7% to
+50.3%), much closer to historical - the single v3 run was just an unlucky
draw. But the real finding is the _variance itself_: baseline's own worst
run (r3) hit 3.87M tokens (worse than card's worst, 1.53M) via the exact
same unmanaged pathology - `solveset.py` read 6x, `relational.py` read 3x,
verification scripts re-run repeatedly, 29 requests in one turn - with zero
mitigation, since baseline runs with no extension loaded at all. That's a
sharper, more defensible product claim than average savings: card bounds
the worst case; an unmanaged session doesn't, and can spiral just as badly
as anything card has ever done, pre- or post-fix.

**Correction, called out by the user and worth keeping visible**: I'd
attributed the redundant-read pattern to "a model like mycoder/gemma4:31b,"
implying it's a weak/cheap-model tax. Wrong - Haiku 4.5, tested earlier the
same session, showed the identical pattern (27 rereads of one file). Only
two models traced today, both did it, one frontier-tier and one cheap. No
basis for a size/capability claim either way; if anything this generalizes
the case for the product rather than narrowing it.

**Three follow-on tasks, user-directed:**

1. **WSL Docker for correctness grading.** WSL2 (`Ubuntu-24.04`) was already
   installed with a working native Docker Engine (`docker --version` inside
   WSL: 29.7.2) - just not reachable from Windows, which is why grading
   failed earlier ("no `docker` on this machine" was Windows-only, not
   actually true). `scripts/evaluation/swebench-windows.py` exists purely
   to shim two Windows-only problems (`resource` module doesn't exist
   there; `Path.write_text` defaults to CRLF) - neither shim is needed
   under WSL, since it's real Linux. Set up a WSL-side venv
   (`~/swebench-venv`, `swebench==4.1.0`, matching the existing Windows venv
   version) and ran the official harness directly
   (`python3 -m swebench.harness.run_evaluation`, no wrapper) against
   `mycoder-18211-n3`'s card-r1 prediction via
   `wsl -d Ubuntu-24.04 -- ...`, reading the repo at its `/mnt/c/...`
   mount - validation run in progress as of this note; not yet wired into
   `grade-swebench.mjs` itself (that's the next step once the manual path is
   confirmed end-to-end).

2. **Session doctor** (`scripts/evaluation/session-doctor.mjs`, `npm run
doctor -- <session.jsonl>`). Every finding today started as a hand-
   written DuckDB query against a raw session log - this automates the
   highest-value ones: tool-call tally, task-state-audit event tally and
   full chronological list of block/cache events, and read-hotspot
   detection (any path read 3+ times, with its offset/limit windows listed).
   Reuses `parseJsonLines` from `metrics.mjs` rather than duplicating it.
   Validated against two fixtures with known ground truth from today: the
   Haiku session (correctly surfaces `inequalities.py` at 27 reads,
   `test_inequalities.py` at 14, with exact offset/limit windows matching
   the manual DuckDB findings) and the mycoder v2 runaway (correctly lists
   all 460 cache-hit events chronologically, the exact repeated `python -c`
   command visible immediately). Not yet unit-tested (it's a dev/ops tool,
   not shipped in `package.json`'s `files`) - validated by fixture instead.

3. **Multi-turn session test** - `evaluation/configs/pi-ten-turn-mixed.json`
   already exists for exactly this (5 related turns, 2 deliberately
   unrelated turns testing task-boundary isolation, mixed into one
   continuing session) but its checked-in results are the same
   pre-`sessionMode: "continue"` staleness already flagged above, and its
   baked-in model (`llama-cloud/gemma4:31b`) no longer exists. Launched
   fresh with `--model ai-inference-router/mycoder`
   (`.agent-context-card/e/mycoder-ten-turn-v1/`) - in progress as of this
   note. This is the scenario the historical big-savings numbers actually
   came from (context accumulating across many turns, not a 3-turn SWE-bench
   pilot), so it's the right next test to see whether the -60.5%-median
   result generalizes to the shape of session this project's thesis is
   really about.

## WSL Docker grading: wired in for real

`scripts/evaluation/grade-swebench.mjs` now has a `--wsl [--wsl-distro
<name>] [--wsl-venv <path>]` flag (explicit opt-in, not auto-detected - see
comment at its definition for why). Under `--wsl` it skips
`swebench-windows.py` entirely (that wrapper only shims two Windows-only
problems - no `resource` module; `Path.write_text` defaulting to CRLF -
neither applies under WSL, which is real Linux) and instead runs
`python3 -m swebench.harness.run_evaluation` directly via
`wsl -- bash -c "cd <mounted-path> && ..."`, with every argument shell-
quoted (`shellQuote`) and Windows paths translated to their `/mnt/c/...`
mount (`toWslPath`) - output lands on the real Windows filesystem either
way, so nothing needs translating back. Validated manually first (built the
sympy Docker image, applied a real patch, got `resolved: false` back) before
wiring it into the script itself.

## Ten-turn mixed config: two harness bugs, not one, and a design discussion

The `pi-ten-turn-mixed.json` "correct: no" investigation turned up two
independent, real harness bugs - not the single task-switch-staleness issue
it first looked like.

**Bug 1 (bigger than expected): snapshot assertions could never pass, for
any config, ever.** `readTaskSnapshots()` in `run.mjs` reads
`<workspace>/.agent-context-card/tasks/*.json`. `SessionCardStore` defaults
to `~/.agent-context-card/cards/` - a different base directory _and_ a
different folder name - unless redirected via
`AGENT_CONTEXT_CARD_TEST_CARDS_DIR`. Checked the child-process environment
`run.mjs` builds when spawning `pi`: only `PI_TELEMETRY` and conditionally
`PI_CODING_AGENT_DIR` were ever set. Every eval run's card snapshots have
been landing in the real, shared, global profile directory - not scoped to
the run at all - while `snapshotPlanContains` assertions read an empty
directory that was never populated. Fixed: `run.mjs` now sets
`AGENT_CONTEXT_CARD_TEST_CARDS_DIR = path.join(workspace,
".agent-context-card", "tasks")` per spawned process, matching exactly what
`readTaskSnapshots()` already expected.

**Bug 2: the task-switch-staleness issue from before, confirmed and fixed.**
Verified directly (`continuity.taskId` was `ACCMIX-301` in all 25 projection
snapshots across all 10 turns of the card session, never switching) that
this matches AGENTS.md's documented, intentional design - not a defect.
Fixed `evaluation/configs/pi-ten-turn-mixed.json`: turns 6-10's `taskId`
expectations changed from `ACCMIX-302/303/303/303/304` to `ACCMIX-301`
(the anchor that actually, correctly, persists); dropped `noPlan: true`
from turns 6 and 10 (the plan does persist by design, there's nothing left
to assert there); dropped `resume: true` from turns 2-5 and 8-9 (provably
unsatisfiable under `sessionMode: "continue"` - no `"load"` audit op ever
fires when branch replay reconstructs state directly, confirmed both here
and independently during the SWE-bench pilot investigation above; also
redundant with the `taskId`/`planRevision` checks that already verify
continuity through a mechanism that _does_ fire). Also fixed the config's
own baked-in model (`llama-cloud/gemma4:31b`, doesn't exist) to
`ai-inference-router/gemma4:31b`, matching the same fix already applied to
both SWE-bench pilot configs in commit `8abfa17`.

**Left deliberately untouched**: `zeroHotEvidence` showed a mixed, not
cleanly-explained pass/fail pattern in the original run (FAIL on turns 2,
5, 8; PASS on 3, 4, 6, 9, 10) - unlike `resume`, this doesn't look like a
clean "always wrong under continue mode" case, more like something that
depends on actual per-run model behavior (whether a turn happened to
re-read something not yet retired). Didn't have a confident diagnosis, so
didn't touch it rather than guess. If `correct` still isn't clean after
the rerun below, this is the remaining suspect.

Rerun launched with both fixes in place
(`.agent-context-card/e/mycoder-ten-turn-v2/`) - in progress as of this
note.

**Design discussion, prompted by this investigation**: is there a better
middle ground than the current "one anchor per session, never auto-switch"
default (deliberately chosen over the old vocabulary-heuristic
auto-detection, which was removed for producing costly, invisible false
positives - AGENTS.md, "Second SWE-bench Verified pilot")? Landed on:
the failure mode of the old heuristic was the _harness_ guessing relevance
from surface text. A better signal would have the _model_ explicitly
declare a new goal (e.g. a `newGoal` field on `update_card`, distinct from
the persistent `goal` field so restating current work is never
mistakeable for a switch), compared deterministically against the pinned
anchor - no semantic guessing by the framework at all, since the model has
full context and the framework doesn't need to. User specifically rejected
ticket-ID pattern matching as the trigger (this repo's own real usage today
never had a ticket ID anywhere - only benchmark fixtures use JIRA-style
IDs, so any ID-gated mechanism would only ever fire in benchmarks, not real
solo-developer usage) in favor of goal-change as the general signal. Not
built yet - the plan is: fix the harness first (this section), run the
ten-turn config cleanly to get a real baseline, then use that data to
estimate how much token/request overhead is actually attributable to _not_
having goal-switching (turns 6 and 10, the deliberately-unrelated ones)
before deciding whether it's worth building.

## Ten-turn v3: harness fixes confirmed, clean `correct: yes/yes`

Reran with both harness fixes (snapshot-path wiring, stale config
assertions) in place: `.agent-context-card/e/mycoder-ten-turn-v3/`. All 21
continuity assertions PASS, `correct: baseline=yes, card=yes` for the first
time on this config. Total provider input: baseline 287,751, card 115,177
(-60.0%) - closely matching the -60.5% median from the SWE-bench n=3 gate
earlier. At the time this looked like the clean multi-turn baseline the
whole session had been working toward.

It wasn't clean. See below.

## First commit + push checkpoint

User asked to commit and push before going further into goal-switching, and
to treat frequent commits as a standing practice (easier to revert). Fixed
two more `tsc` errors this surfaced (`"cache"`/`"hit"` weren't in
`TaskStateAudit`'s `operation`/`status` unions - the pre-existing WIP this
session had been building on top of all along) - full validation clean
after. Five commits pushed to `origin/main` (`0d4c977..14b5473`):

1. `d1d719b` - the three loop-safety fixes (reflection escalation,
   range-containment reads, cache-cap) plus the two type-union fixes.
2. `6970e9e` - the session doctor.
3. `b529945` - WSL Docker grading.
4. `bffdb3a` - the two ten-turn-mixed harness bugs (snapshot-path wiring,
   stale assertions).
5. `14b5473` - this note.

## The goal-switching question turned out to be a measurement bug

Went to check what `review-increment` actually does that leaves so much
context live for turn 6 to inherit (the ~31K-token gap between card's
`unrelated-package` cost and its own steady-state cost in v3). Traced it:
`review-increment`'s only tool calls are `git diff` and
`npm run test:increment` - no file reads at all, so "evidence not retired"
was never the mechanism. The actual cause: `git diff`'s result was **51,320
characters** in one message, and diffing its content showed it was a diff
of `pi-ten-turn-mixed.json` itself - this repo's own file, not anything in
the counter-mixed fixture.

Root cause: `prepareWorkspace()` for `workspace.type: "copy"`
(`scripts/evaluation/run.mjs`) does a plain recursive file copy with no
`git init`. Confirmed neither `evaluation/fixtures/counter-mixed` nor the
copied workspace has its own `.git`. Since the copy destination
(`.agent-context-card/e/.../w`) is nested inside this repo's own working
tree, any `git diff`/`git status`/`git log` the model runs searches upward,
finds this project's real `.git`, and operates on **this repo's own
uncommitted state** instead of the fixture. At the moment the v3 run
executed, this session's own uncommitted `pi-ten-turn-mixed.json` changes
were sitting in the working tree - that's what leaked in.

This invalidated the "review turns leave lingering evidence" theory (never
about evidence at all) and meant every `zeroHotEvidence`/cost number from
every ten-turn-mixed run today, v1 through v3, needs to be read with that
caveat. Only `"type": "copy"` configs are affected -
`pi-ten-turn-mixed.json` and presumably `pi-plan-phase-experiment.json`/
`pi-ten-turn-plan-framing.json`; the SWE-bench pilots use `"type": "git"`
(a real clone) and are unaffected. This also means every _historical_
ten-turn-mixed-family result in AGENTS.md (the "Ten-session mixed proof,"
"GPT-5 Nano ten-session proof," and the controlled n=3 gates) carries the
same unquantified risk - whatever was uncommitted in this dev repo at the
moment each ran could have leaked in.

**Fix**: `prepareWorkspace()` now runs `git init` + `add -A` + a `--no-verify`
commit in the copied destination, with committer identity passed via env
(`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/etc.) rather than depending on
whatever global git config happens to be set on the machine running this.
Verified standalone against the real fixture before rerunning anything:
`git diff` now correctly returns 0 bytes, `git status` correctly reports a
clean tree.

## Ten-turn v4: the actually-clean baseline

`.agent-context-card/e/mycoder-ten-turn-v4/`. `correct: yes/yes` again.
Numbers changed substantially now that the leak is gone:

| Turn                       | v3 (contaminated) | v4 (clean) |
| -------------------------- | ----------------: | ---------: |
| baseline review-increment  |            38,674 |      8,028 |
| baseline unrelated-package |            36,883 |      6,041 |
| baseline unrelated-readme  |            39,138 |      8,351 |
| **total baseline**         |           287,751 |     72,502 |
| **total card**             |           115,177 |     54,766 |
| **savings**                |            -60.0% | **-24.5%** |

Card's per-turn cost is now flat across the entire session (4,264-7,058,
no spikes anywhere) - the "spike" turns in every prior run were the leak,
not something inherent to review/unrelated turns. The -60.0% figure that
looked like it was confirming the project's historical numbers was itself
partly an artifact: the leak inflated baseline disproportionately (baseline
has no mechanism to ever shed the leaked diff; card's retirement machinery
apparently cleared it by the time it mattered), flattering card's relative
number. -24.5% is the real, trustworthy figure for this fixture - still a
genuine win, just a smaller one, and on a 3-file fixture with a naturally
tiny context ceiling, not necessarily representative of a longer real
session.

**Goal-switching verdict, with clean data**: `unrelated-package` (turn 6)
now costs card 4,876 - barely above its own cheapest turns elsewhere in the
same session (4,264-4,541). The remaining gap a goal-declaration mechanism
could capture is a few hundred to ~2,000 tokens on one turn type, not the
~31,000-token ceiling the contaminated v3 data implied. **Conclusion:
don't build `newGoal`/goal-switching on this evidence** - the existing
evidence-retirement machinery is already doing nearly all the real work
without it. The bigger, higher-confidence lesson from this whole thread was
the workspace-isolation bug itself, not a case for a new feature.

## Current status (final, this session)

Everything through the first push (`14b5473`) is on `origin/main`. Not yet
pushed as of this section: the workspace-isolation fix
(`prepareWorkspace()` git-init) - queued for a second commit+push once this
note and the changelog are updated, per the same "commit before moving on"
practice as the first checkpoint.

**Resolved this session**: the two original CoreApps loop bugs (unbounded
read oscillation via range-containment; unbounded cache-hit bypass);
snapshot-path wiring; stale ten-turn-mixed assertions; the workspace git-
isolation leak. **Open, unchanged**: the `bash`/grep near-duplicate
detection (no fix attempted - different, fuzzier problem, deliberately not
tackled here); reconciling `evidence-ledger.json`'s `claimable: true` flags
on `swebench-sympy-18211`/`21930` against its own `methodologyCaveat`
(flagged, not fixed); the `zeroHotEvidence` mixed pass/fail pattern noted
in the v2 section above (turns 2/5/8 fail, 3/4/9/10 pass) - not
investigated further once the workspace-isolation bug turned out to be the
dominant factor, worth a fresh look now that measurement is trustworthy;
official SWE-bench correctness grading only exercised manually and on one
prediction so far (card-r1 from `mycoder-18211-n3`, `resolved: false`) -
the other five predictions from that n=3 gate are still ungraded.
