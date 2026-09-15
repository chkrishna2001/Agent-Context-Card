# Repeat-detection & eval-harness follow-ups

**Status (2026-09-15): the triggering bugs are fixed, tested, committed, and
pushed to `origin/main` at `e65870d`. Working tree is clean. Four follow-up
investigation threads are open and unstarted — none blocking, none started.**
Safe to build on; nothing here is half-finished code.

## What we're working on

`agent-context-card` is a Pi coding-agent extension whose thesis is: an
agent can work with a much smaller context than "resend the whole
conversation" by tracking task state deterministically (see `AGENTS.md` at
repo root for the full mission/design). This session started from a user
report — two real Pi sessions in an unrelated project (`CoreApps`) where a
model got stuck resubmitting a blocked tool call forever — and expanded
into (a) fixing three distinct ways a model could loop past every existing
safety net, and (b) discovering and fixing two serious, previously-unknown
bugs in the evaluation harness itself that had been silently invalidating
measurement for an entire family of configs.

Hard constraint that shaped every fix here: **the project's own design
philosophy rejects semantic/heuristic guessing in favor of deterministic,
event-driven logic** (`AGENTS.md`, "Ideas considered and rejected as
defaults"). Every fix below is a structural/deterministic check (exact
signature, line-range containment, a hard count threshold), never a
similarity score or classifier. This constraint is _why_ a "goal-switching"
feature was discussed at length and explicitly **not** built — see below.

## What we achieved

All verified with the full validation suite (`bun test`, `bun x tsc
--noEmit`, `bun x eslint .`, `bun x prettier --check .`, `bun build
index.ts --outdir dist --target node`) clean before each of the 6 commits
below landed.

1. **Reflection escalation on the hard repeat-block**
   (`src/pi/index.ts`, commit `d1d719b`). Traced two live sessions where a
   model kept resubmitting an already-blocked call 8 and 20+ times because
   the block's refusal is a tool-result the model reads as "that call
   failed," not a steering signal. Fix: once the hard block engages, send a
   real user-turn message (`pi.sendUserMessage`, not the pre-existing
   custom/steer nudge channel) asking the model to name its goal, capped at
   `HARD_BLOCK_REFLECTION_STREAK_CAP` (2) per stuck signature.

2. **Range-containment redundant-read detection**
   (`src/core/intervals.ts`, new module; wired into `src/pi/index.ts`;
   same commit). Traced a live Haiku 4.5 session: 27 reads of one 996-line
   file, no two sharing the same `offset`/`limit`, so the exact-signature
   hard block never engaged even once. Fix: track the union of line ranges
   read per path (`mergeInterval`/`isFullyCovered`); block a read whose
   entire requested range is already covered, regardless of exact
   arguments. Deliberately **not** keyed on path alone — verified this
   doesn't block legitimate sequential reads of a large file in new,
   non-overlapping chunks (see `tests/pi-adapter.test.ts`, the three tests
   added alongside this fix).

3. **Capped the success cache** (`src/pi/index.ts`, same commit). Found
   this by accident while stress-testing fix #2: a _separate_, pre-existing
   uncommitted mechanism (`successfulCallCache`) served a cached result for
   any repeat of a signature that had succeeded once, with **no cap at
   all**. Traced a live run where this silently served the same bash
   command 446 times over a full 20-minute turn timeout — worse than the
   original bug, because a cache hit looks like a normal success to the
   model, giving it zero signal to stop. Fix: gate the cache-hit path on
   `consecutiveAttemptCount < HARD_BLOCK_REPEAT_THRESHOLD`; at or past the
   threshold it now falls through to the block-and-reflect path instead of
   bypassing it.

4. **Session doctor** (`scripts/evaluation/session-doctor.mjs`, commit
   `6970e9e`). `npm run doctor -- <session.jsonl>`, or `--last [n]` /
   `--list [n]` to find recent session files without knowing the path
   (searches `~/.pi/agent/sessions/**` and this repo's own
   `.agent-context-card/e/**/s/*.jsonl`, excluding trace files by directory
   convention). Reports tool-call tallies, a chronological list of
   block/cache audit events, and read hotspots (path read 3+ times, with
   offset/limit windows). Validated against two known fixtures from this
   session (correctly reproduced both the 27-read hotspot and the 460-cache-hit
   loop in one command each — see the working notes below for the exact
   output).

5. **WSL Docker wired into SWE-bench grading**
   (`scripts/evaluation/grade-swebench.mjs`, commit `b529945`). New `--wsl`
   flag (explicit opt-in) routes grading through `wsl -- bash -c ...`
   against a WSL-side Python venv instead of Windows-native, since this
   machine has no native Windows Docker but does have a working WSL2 +
   Docker install. Validated end-to-end manually first (built the sympy
   Docker image, applied a real patch, got a genuine `resolved: false`
   verdict) before wiring it into the script.

6. **Two eval-harness bugs found and fixed**:
   - `run.mjs` never set `AGENT_CONTEXT_CARD_TEST_CARDS_DIR` when spawning
     `pi`, so every eval run's card snapshots landed in the real, shared,
     global `~/.agent-context-card/cards/` instead of the workspace-local
     path the harness's own `readTaskSnapshots()` reads —
     `snapshotPlanContains` assertions could never pass, for any config,
     ever. Fixed in commit `bffdb3a`.
   - `prepareWorkspace()` for `workspace.type: "copy"` never ran `git init`
     in the copied destination. Since that destination is nested inside
     this repo's own working tree, any `git diff`/`git status`/`git log`
     the model ran searched upward and silently operated on **this repo's
     own uncommitted state**. Traced live: a plain `git diff` during a
     ten-turn-mixed "review" turn leaked 51,320 characters of this repo's
     own unrelated diff into the model's context, inflating every
     downstream token measurement for the rest of that run. Fixed in
     commit `e65870d` (`git init` + `add -A` + a `--no-verify` commit,
     committer identity passed via env, not host git config).

   **Important dead end this surfaced, worth not repeating**: before
   finding the workspace-isolation bug, a rerun of `pi-ten-turn-mixed.json`
   showed card beating baseline by -60.0% total tokens — closely matching
   the project's historical ~-60% to -79% numbers, which felt like
   confirmation. It wasn't. The leaked diff inflated baseline
   disproportionately (baseline has no mechanism to ever shed a stray
   diff; card's retirement machinery apparently cleared it by the time it
   mattered), flattering card's _relative_ number without reflecting real
   behavior. **Do not trust an aggregate percentage that happens to match
   a prior result as confirmation — check the per-turn breakdown for
   spikes first.** The clean rerun after the fix shows a real, smaller,
   still-genuine **-24.5%**, with per-turn cost flat across the whole
   session instead of spiking on review/unrelated turns.

7. **Goal-switching: discussed at length, explicitly not built.** The
   contaminated data above made it look like there was a ~31,000-token gap
   on "unrelated" turns (e.g. `unrelated-package`) that a model-declared
   goal-switching mechanism could capture — the idea being: let `update_card`
   accept a `newGoal` field so the model can explicitly declare a goal
   change (deterministic string comparison against the pinned anchor, no
   harness-side semantic guessing — this was specifically designed to avoid
   the false-positive problem that got the _old_ vocabulary-heuristic
   task-switch detector removed entirely, see `AGENTS.md`). With the
   workspace-isolation bug fixed, the real gap on the same fixture is a few
   hundred to ~2,000 tokens — `unrelated-package` costs card 4,876 tokens,
   barely above its own cheapest turns elsewhere in the same session
   (4,264-4,541). **Conclusion: not worth building on this evidence.** If
   this gets revisited, it needs a _longer, more realistic_ session (not
   this 3-file fixture, which has a naturally tiny context ceiling) to
   re-measure the gap before reconsidering.

## What's next

Four independent, unstarted threads. None blocks any other.

1. **Investigate the `zeroHotEvidence` mixed pass/fail pattern.** In the
   _clean_ ten-turn-mixed data (post workspace-isolation fix), this
   assertion still needs checking — it showed a reproducible (not random)
   pattern across two contaminated runs (FAIL on turns 2/5/8, PASS on
   3/4/9/10) before the workspace bug was found and fixed, and was never
   re-examined against clean data. Could be a real, explicable pattern
   (e.g. tied to which turns leave a read unconsumed by a mutation grace
   boundary) or could itself be another stale assertion. Not touched
   because the workspace bug turned out to dominate everything else in the
   same investigation.

2. **`bash`/grep near-duplicate detection** — a distinct, unaddressed gap
   from #3 above. Traced live (mycoder session): `grep -r "def as_set"
sympy/core/relational.py sympy/core/expr.py ...` fired 5 times in 6
   seconds with slightly different trailing file-list arguments each time
   — never matched the exact-signature check, never matched the
   range-containment check (that's read-specific), so it looped
   unimpeded. Needs a different, fuzzier approach (e.g. normalize by
   command verb + primary search pattern, ignoring trailing argument
   variation) — explicitly flagged as riskier than the read fix and not
   attempted.

3. **Reconcile `evaluation/results/evidence-ledger.json`'s stale
   `claimable: true` flags.** Its own `methodologyCaveat` field says every
   result whose id starts `swebench-sympy` used the removed
   `sessionMode: "fresh"` cross-session bridge and is "pending re-run, not
   current evidence" — but both `swebench-sympy-18211` and
   `swebench-sympy-21930` entries are still marked `claimable: true`. The
   flag was never corrected to match the caveat. Also: no equivalent
   caveat exists for `pi-ten-turn-mixed.json`-family results even though
   they have the exact same staleness problem (confirmed and fixed this
   session, see #6 above) — the ledger's historical ten-turn-mixed/GPT-5-Nano
   entries need the same caveat treatment.

4. **Grade the remaining SWE-bench predictions.** Only 1 of 6 predictions
   from today's n=3 gate (`.agent-context-card/e/mycoder-18211-n3/`,
   **gitignored, local-only, see warning below**) has been officially
   graded via Docker: `card-r1`, result `resolved: false`. The other 5
   (`baseline-r1/r2/r3`, `card-r2/r3`) are ungraded — efficiency numbers
   exist for all 6, correctness only for one.

## How to do it

**Repo/tooling context**: Windows dev machine, WSL2 distro `Ubuntu-24.04`
(the system default — no `-d` flag needed), with a working Docker Engine
already installed _inside_ WSL only (not on the Windows host at all — that
distinction is why grading needed `--wsl`). A Python venv already exists at
`~/swebench-venv` inside WSL with `swebench==4.1.0` installed — don't
recreate it, it's ready to use.

**Doctor tool** (thread #1's starting point):

```bash
npm run doctor -- --list 10                    # see recent session files
npm run doctor -- --last                       # analyze the most recent one
npm run doctor -- <path/to/session.jsonl>       # analyze a specific one
```

**Rerunning the ten-turn-mixed gate** (thread #1):

```bash
node scripts/evaluation/run.mjs \
  --config evaluation/configs/pi-ten-turn-mixed.json \
  --model ai-inference-router/mycoder \
  --output .agent-context-card/e/<pick-a-name>
```

Then check `<output>/report.md`'s per-turn table for `zeroHotEvidence`
PASS/FAIL by turn, and if still mixed, use `npm run doctor -- --last` (or
point it at the relevant `s/*.jsonl` under `<output>/r2-1/s/`) to find what
each failing turn's assertion condition (`firstProjection.hotEvidence`) was
actually seeing — cross-reference against the `continuityAssertions`
function in `scripts/evaluation/run.mjs` (search for `zeroHotEvidence`) to
see exactly what's being checked.

**Grading more predictions** (thread #4):

```bash
node scripts/evaluation/grade-swebench.mjs \
  --report .agent-context-card/e/mycoder-18211-n3/report.json \
  --wsl \
  --variant baseline    # or: card   (grades every repeat of that variant; omit --variant for all 6)
```

Each instance takes a few minutes (mostly Docker image build/pull on first
use, cached after). Results land in
`.agent-context-card/e/mycoder-18211-n3/swebench-grades/<timestamp>/`,
one `report.json` per graded run in the official swebench format
(`resolved`, `tests_status.FAIL_TO_PASS`/`PASS_TO_PASS`).

**⚠ `.agent-context-card/` (including `e/`, all eval output, all
predictions/reports referenced above) is gitignored** (`.gitignore` line 6) — everything under it is local-only on this machine and will not survive
a fresh clone or a cleaned checkout. If those files are gone when you pick
this up, regenerate with the commands above (same config, same fixture,
fully reproducible) rather than treating their absence as a problem.

**DuckDB query pattern** that works reliably against these `.jsonl` session
files (documented at length, with the exact error it avoids, in
`docs/notes/hard-block-reflection-escalation-2026-09-14.md` under "Where
this started"): isolate one JSON field per row in its own CTE before
chaining a second `->>`/`json_each`, or DuckDB throws a spurious
`Conversion Error: Failed to cast value to numerical` on rows with
heterogeneous schemas.

**Full raw trail**: `docs/notes/hard-block-reflection-escalation-2026-09-14.md`
has the complete chronological investigation — exact numbers, every dead
end, the full reasoning behind every design choice above. Read it before
re-deriving anything that feels like it should already have an answer.

## What we expect from it

- **Thread #1 (`zeroHotEvidence`)**: either a clear explanation tying the
  pass/fail pattern to a specific, correct mechanism (in which case fix the
  config's expectations to match, the same way `taskId`/`resume`/
  `planRevision` were fixed this session), or a confirmed real bug in
  retirement timing (in which case it needs a proper fix in
  `src/core/projection.ts`, not a config edit). Don't guess — reproduce it
  with clean data first the way this session did for the other three
  stale-assertion cases.
- **Thread #2 (`bash`/grep)**: a design for the "fuzzy match" needs to be
  validated against real false-positive risk before shipping — a normalize-
  by-verb approach could plausibly block a legitimate `grep` with
  genuinely different search terms that happen to share a verb. Write it
  with the same rigor as the read fix: a dedicated test proving legitimate,
  differently-scoped commands are never blocked, not just that the repeat
  case is caught.
- **Thread #3 (evidence-ledger)**: this is a documentation/bookkeeping fix,
  not code — update `claimable` flags and add the missing caveat, run
  `tests/evaluation.test.ts` (which recalculates published percentages from
  raw counts) to confirm nothing else depends on the stale flag.
- **Thread #4 (grading)**: once all 6 are graded, the real result is a
  correctness comparison (X/3 baseline resolved vs Y/3 card resolved) —
  report that number plainly, the way GPT-5 Nano's 0/3 controlled result is
  reported in `AGENTS.md`, not just the efficiency percentage. If
  correctness is worse for card, say so as plainly as when it's better.
- **General bar, learned the hard way this session**: before trusting any
  aggregate percentage — especially one that happens to match a prior
  expected result — check the per-turn/per-instance breakdown for spikes.
  A number that "looks right" is not verification.

**This doc will need updating again** once any of the four threads above is
started or finished — update its status line and fold in what changed,
rather than leaving it to go stale the way the eval configs it describes
did.
