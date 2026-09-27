# Repeat-detection & eval-harness follow-ups

**Status (2026-09-27): the 2026-09-15/16 threads (#1, #4-#7) are done,
committed, and pushed. The 2026-09-16 Haiku cache-cost mystery (thread #5)
is still open and untouched this session — read
`docs/notes/haiku-cache-defeat-2026-09-16.md` before touching anything
cache-related. This session (2026-09-27) reworked the repeat-detection
mechanism itself (threads #2/#3 below are rewritten, not just extended —
the old "capped success cache" no longer exists at all), fixed two real
bugs found via live SWE-bench runs, unified staleness detection onto
`src/core/projection.ts`'s `hotEvidence`, and ran the project's first
controlled (n=3), automatically-graded evidence of the day. Committed and
pushed: `9e8001d` (the code/doc changes) and `17515ba` (an unrelated batch
of pre-existing SWE-bench pilot-campaign tooling/results that predated this
session but got committed in the same pass at the user's request). Working
tree is clean. Safe to build on.**

## What we're working on

`agent-context-card` is a Pi coding-agent extension whose thesis is: an
agent can work with a much smaller context than "resend the whole
conversation" by tracking task state deterministically (see `AGENTS.md` at
repo root for the full mission/design). This thread is specifically about
one supporting mechanism: stopping a model from looping — re-reading a file
it already has, re-running the same search, or repeating an identical tool
call — since an unbounded loop defeats context-bounding regardless of how
good the retirement logic is.

Hard constraints that shaped every fix here:
- **No semantic/heuristic guessing** (`AGENTS.md`, "Ideas considered and
  rejected as defaults") — every repeat-detection check is structural
  (exact signature, line-range containment, a hard count threshold), never
  a similarity score.
- **Staleness has exactly one source of truth** (new rule this session,
  `AGENTS.md` under "Evidence leases" → "Single source of truth for
  staleness"). Any code anywhere that needs to know whether previously-seen
  evidence is stale must derive that from `src/core/projection.ts`'s
  `hotEvidence`/mutation-gate logic — never invent an independent notion of
  staleness in an adapter. This rule exists *because* violating it cost two
  real bugs in one afternoon this session (see below) — read that AGENTS.md
  section for the incident, it's the actual justification, not boilerplate.

## What we achieved

All verified with the full validation suite (`bun test`, `bun x tsc
--noEmit`, `bun x eslint .`, `bun x prettier --check .`) clean before
committing, and every behavioral change was fault-injection tested (broke
it on purpose, confirmed the relevant test failed, restored it) before
being trusted.

1. **Reflection escalation on the hard repeat-block** (`src/pi/index.ts`,
   commit `d1d719b`, 2026-09-15 — unchanged this session). Once the hard
   block engages, `pi.sendUserMessage` asks the model to name its goal,
   capped at `HARD_BLOCK_REFLECTION_STREAK_CAP` (2) per stuck signature.

2. **Repeat detection now blocks on the *first* repeat, uniformly, and
   queries `hotEvidence` for staleness instead of tracking it locally**
   (`src/pi/index.ts`, `src/core/projection.ts`, commit `9e8001d`,
   2026-09-27 — this rewrites the 2026-09-15 range-containment mechanism
   below). Three independent gates in the `tool_call` handler — exact
   signature (`consecutiveAttemptCount`), line-range containment for reads
   (`containedRepeatCounts`/`readCoverage`), and near-duplicate search
   patterns (`bashPatternCounts`) — all key off one constant,
   `HARD_BLOCK_REPEAT_THRESHOLD`, now **2** (was 3). Two real bugs were
   found via live runs while tightening this, not by reasoning:
   - **Off-by-one**: the contained-range counter only increments once a
     read is *already* fully covered, so its first increment is really the
     *second* occurrence — unlike the other two counters, which count the
     establishing occurrence as 1. Comparing it to the same threshold
     silently granted one extra free repeat. Traced live
     (`ai-inference-router/mycoder`, `sympy__sympy-15345`): a model read
     `sympy/printing/mathematica.py` in full three times, the first two
     both executing for real, before the third finally blocked. Fixed:
     that specific check now compares against
     `HARD_BLOCK_REPEAT_THRESHOLD - 1`.
   - **Mutation blindness**: the contained-range coverage map was tracked
     purely by line/offset numbers with no idea a mutation had happened, so
     a successful edit didn't invalidate coverage recorded before it. Live
     consequence (same run, different repeat): a model's edit failed on
     stale `oldText`, it tried to re-read the file to see why, and got
     blocked as "already returned" by coverage from *before* its own
     earlier successful edit — stuck retrying the same wrong edit three
     more times. Fixed by replacing the adapter's own mutation-tracking
     with a live check against `lastAudit.hotEvidence` (computed by
     `src/core/projection.ts`, refreshed every provider request): a lease
     that's absent or `state: "consumed"` means don't trust local coverage
     for that path. `src/core/projection.ts`'s `filePath` is now exported
     for this (ended up unused directly in `index.ts` after the refactor,
     but kept exported — it's the shared canonical path-extraction utility,
     consistent with the single-source-of-truth rule).

3. **The old "capped success cache" no longer exists — removed entirely**
   (`src/pi/index.ts`, commit `9e8001d`). Once repeat blocking fires on the
   *first* repeat (see #2), a signature can never execute successfully
   twice in a row — the gate blocks the second attempt before it happens.
   That made the entire post-execution "did this succeed/fail twice"
   escalation (`repeatedSuccessCount`, `repeatedFailureCount`,
   `forcedDueToRepeatedSuccess`, `successfulCallCache`, and the
   `update_card` "compelled by repeated success" steer message) unreachable
   dead code. Deleted, along with its tests. If you're reading old context
   that mentions "the success cache" or "repeatedSuccessCount" — it's gone,
   this is why.

4. **Citation-forcing**: a forced `update_card` call is no longer treated
   as resolved just because it produced *some* substance — it must cite at
   least one currently-active read (`findings[].sources`) if any exist,
   or the forcing streaks stay live and a targeted steer names the uncited
   paths (`src/pi/index.ts`, `citationThin`, commit `9e8001d`). This is the
   only mechanism that can retire a read before any mutation has landed
   (`consumedByDisuse` is deliberately gated off until a mutation happens —
   see the comment on it in `src/core/projection.ts` and the Laya
   evaluation it cites), so it's the one lever available for pure
   investigation turns specifically.

5. **Session doctor**, **WSL Docker grading**, **the two eval-harness bugs
   (card-snapshot directory, workspace git-isolation)**, and **the decision
   not to build model-declared goal-switching** — all from 2026-09-15/16,
   unchanged this session. Still accurate as originally written; see git
   history for this file if you need the original prose.

6. **A real, controlled (n=3) result — the first non-anecdotal evidence
   gathered this session.** Ran the checked-in
   `evaluation/configs/pi-ten-turn-mixed.json` gate (`ai-inference-router/
   gemma4:31b`, `--repeats 3`): **baseline 3/3 correct, card 3/3 correct**,
   every one of card's 78 continuity assertions passed (26 × 3, zero
   FAILs), provider-input tokens down a median **-16.8%** with the
   reduction in the same direction on all 3 repeats (range -22.8% to
   -12.6%, never crossing zero), tool/request counts statistically flat,
   zero tool errors either side. Real caveats, not overclaimed: this
   fixture never triggers a repeat in either variant (0 raw/same-state
   repeated signatures throughout), so it doesn't exercise anything from
   #2/#3 above — and `hotEvidence` stays tiny (0-3) the whole session, so
   it doesn't stress-test "retire a lot while keeping quality" the way the
   SWE-bench spot-checks below did. It proves the fixes cost nothing on
   ordinary work; it isn't evidence about loops or large-scale retirement.

7. **Ad hoc SWE-bench spot-checks (single-run each, `sympy__sympy-15345`,
   not n≥3 — treat as diagnostic, not proof):**
   - `ai-inference-router/mycoder`, after both bugs in #2 were fixed: card
     completed all 3 turns, 69% of messages retired by the end (41/59),
     produced a correct patch verified against the actual reproduction and
     a passing `pytest` run. The one clean supporting anecdote for the
     "retire a lot, keep quality" thesis.
   - `ai-inference-router/gemma4:31b`, same instance: **baseline's
     implement turn timed out** after 448 tool calls / 425 duplicates (20
     min ceiling) — a full runaway loop, on baseline, with *zero* repeat
     protection. Card completed in 131s with 3 duplicates, but **card's own
     patch had a real regression** in this run — an imprecise edit
     deleted the unrelated, pre-existing `_print_Derivative` method while
     adding the requested `_print_Max`/`_print_Min` fix. Not caused by
     retirement or repeat-detection; a plain bad edit-tool match, and
     `pytest` didn't catch it because `test_mathematica.py` never exercises
     `Derivative` printing. Fixed by hand in that run's disposable eval
     workspace only (`.agent-context-card/e/.../w/`, gitignored, does not
     persist) purely to verify the fix pattern — **not committed anywhere,
     re-derive it if you need to see it again**: add back
     `_print_Derivative` (the original 3-line body, `Hold[D[...]]`)
     alongside the new `_print_Max`/`_print_Min` methods in
     `sympy/printing/mathematica.py`.
   - The takeaway that matters more than either single result: **model
     behavior swings enough between runs of the identical config that a
     single run proves nothing either direction** — baseline was clean and
     fast on one run of this exact instance/model, then timed out
     catastrophically on the next. This is why item #6 (controlled n=3) is
     the one result worth citing, not these two.

8. **A real methodology mistake this session, worth not repeating**: misread
   a DuckDB query's truncated terminal display (a `···` row eliding the
   middle of a result set) as proof that `progressStreak`'s
   self-assessment nudge had *never* fired in a real run, and reported that
   as a finding. Added a temporary diagnostic (`taskAudit` logging
   `progressStreak`/`anchor.goal`/`progressStreakNudgeStreak` on every
   `tool_execution_end`), reran, and the direct, untruncated evidence proved
   the mechanism fires exactly as designed
   (`streak=12; hasGoal=true; nudgeStreak=0` → `progress self-assessment
   nudge fired; streak=12`, same handler invocation). The diagnostic was
   removed after confirming this (not committed). **Lesson: when checking
   whether a log line exists or not, `grep -c` the raw file directly —
   never conclude absence from a display tool's own elision.**

## What's next

1. **Thread #5 (Haiku cache-cost mystery) — still open, untouched this
   session.** See `docs/notes/haiku-cache-defeat-2026-09-16.md`. Every
   client-side theory has been checked and ruled out; next step needs
   either a token-level payload diff nobody's found yet, or Anthropic-side
   account visibility this codebase can't produce.
2. **The Laya staleness-signal research — deferred again, not started.**
   The open problem: `consumedByDisuse` is gated off until a mutation lands
   because a controlled 155-read evaluation found its accuracy collapses to
   8-38% without that gate (see the comment on `consumedByDisuse` in
   `src/core/projection.ts`). Citation-forcing (#4 above) is the one
   mechanism that doesn't need a mutation, but it depends on the model
   actually populating `sources`, which has been unreliable historically.
   No better zero-mutation signal has been proposed or tested yet.
3. **Get a real n≥3 result on a fixture that actually stresses retirement
   at scale**, not just the cheap `counter-mixed` gate. The SWE-bench
   spot-checks are the only evidence of large-scale retirement
   (item #6/#7 above) and they're single-run. Repeat the `mycoder` +
   `sympy__sympy-15345` comparison (or a similar SWE-bench instance) 3
   times each side and check whether the "69% retired, quality intact"
   result holds up, or was itself a lucky draw the same way baseline's
   clean-vs-timeout runs were.
4. **A sharper test than "did it work end to end"**: nothing this session
   isolated a case where retirement *itself* (not a bad edit, not model
   variance) caused a quality regression — i.e., discarded evidence that
   was later needed. That's the real failure mode this thesis needs to be
   checked against, and it hasn't been looked for directly yet.
5. Every SWE-bench spot-check today (mycoder and gemma4:31b both) FAILed
   the `planRevision: 1` continuity assertion on turns 2/3, consistently,
   across all three individual runs. It never happened on the ten-turn-mixed
   gate (item #6, 0 FAILs). Not investigated — likely something about how
   these specific SWE-bench configs' prompts interact with plan-promotion
   detection, not a regression from this session's changes (it predates
   them), but worth a look before trusting `planRevision` assertions on any
   SWE-bench config.

## How to do it

**Repo/tooling context**: Windows dev machine, WSL2 distro `Ubuntu-24.04`,
Docker inside WSL only. Local model catalog (what `ctx.model.contextWindow`
actually resolves to, checked once this session after a real 88%-vs-0.888%
misreading mistake — see "What we learned" below) lives at
`~/.pi/agent/models.json`, *not* on the internet — e.g. `mycoder`'s
declared context window there is `192000`, `gemma4:31b`'s is `262144`; they
are declared separately, not aliases of each other, even though `mycoder`'s
real backend model varies at runtime (documented elsewhere in this repo).

**Rerunning the controlled n=3 gate** (item #6 — the one result worth
trusting):

```bash
node scripts/evaluation/run.mjs \
  --config evaluation/configs/pi-ten-turn-mixed.json \
  --repeats 3 \
  --output .agent-context-card/e/<pick-a-name>
```

Check `<output>/report.md`'s "Repeated-run distributions" table for the
median + range across the 3 repeats, and the per-repeat "Assertions"
section for continuity PASS/FAIL. `--model` can override the config's
default (`ai-inference-router/gemma4:31b`) if testing a different backend —
note the OpenRouter-routed reasoning-marked models (e.g.
`openrouter-pinned/google/gemma-4-31b-it`) reject `thinking: "off"` outright
and need an explicit `--thinking low`.

**Rerunning a SWE-bench single-instance spot-check** (item #7 — diagnostic
only, not proof; run it 3x per side before trusting a comparison):

```bash
node scripts/evaluation/run.mjs \
  --config evaluation/benchmarks/generated/sympy__sympy-15345.json \
  --model ai-inference-router/mycoder \
  --repeats 1 \
  --output .agent-context-card/e/<pick-a-name>
```

Swap `--model` for `ai-inference-router/gemma4:31b` to reproduce the
baseline-timeout / card-regression run from item #7. Check correctness by
hand, not just the report table — `cd <output>/r*/w` (the per-variant
workspace) and `git diff`, then actually run the reproduction case and any
relevant test file; "ungraded" in the report table means exactly that, no
official SWE-bench grading ran.

**Adding the diagnostic pattern back** if a mechanism looks like it isn't
firing (item #8's lesson): add a `taskAudit("forcing", "info", ...)` call
logging the exact variables the fire condition depends on, right before the
`if` check, in `src/pi/index.ts`'s `tool_execution_end` handler. Rerun,
then:

```bash
grep -c "<your diagnostic marker string>" .agent-context-card/e/<run>/r*/s/*.jsonl
```

Direct `grep` on the raw file, not a DuckDB query with a row-count limit —
DuckDB's terminal display elides middle rows of a large result with a
`···` placeholder, which reads exactly like "nothing here" if you're not
watching for it. Remove the diagnostic once you've confirmed the answer;
don't commit it.

**⚠ `.agent-context-card/` is gitignored** — every eval run's output
(reports, per-turn traces, session logs, the disposable git workspace) is
local-only and will not survive a fresh clone. Regenerate with the commands
above rather than expecting these files to exist.

**Doctor tool** (still works, unchanged):

```bash
npm run doctor -- --list 10
npm run doctor -- --last
npm run doctor -- <path/to/session.jsonl>
```

## What we expect from it

- **Don't trust a single eval run in either direction.** This session
  found baseline clean-then-catastrophic on the identical config/model/
  instance, and card efficient-then-regressed on the next run of the same
  thing. Any future comparison needs n≥3 per side (matching the project's
  own stated release-gate rule) before being cited as evidence, full stop —
  the `counter-mixed` n=3 result (item #6) is the template.
- **Don't accept a display tool's truncation as evidence of absence.**
  `grep`/`wc -l` the raw file directly before concluding a log line never
  appeared (item #8).
- **Correctness needs to be checked by hand, not inferred from the report
  table.** "ungraded" SWE-bench runs need a manual diff read + an actual
  rerun of the reproduction case + the relevant test file — a clean-looking
  diff can still delete an unrelated method (item #7's `_print_Derivative`
  regression), and the project's own test suite for that file didn't catch
  it because it never exercised the deleted method.
- **Before adding a fourth independent repeat/staleness counter anywhere**,
  don't. Extend or query `hotEvidence` (`src/core/projection.ts`) instead —
  that's now a documented hard rule (`AGENTS.md`, "Single source of truth
  for staleness"), added specifically because not following it cost two
  real bugs in one session.
- This doc will need updating again once either the Haiku thread, the Laya
  research, or the "n=3 SWE-bench-scale retirement" item above actually
  moves — update the status line and fold results into the relevant
  numbered item in place, the way this revision folded today's fixes into
  items #2/#3 instead of stacking a new dated section on top.
