# Retirement-logic centralization and disuse gating

**Status (2026-09-25): code change is done, typechecked, linted, formatted,
and fully test-covered (168/168 `bun test` passing, up from 167). It is
**NOT YET COMMITTED** — working tree is dirty. Safe to build on or commit as-is;
nothing here is half-finished. Two unrelated pre-existing uncommitted diffs
(`src/pi/index.ts`, `tests/pi-adapter.test.ts`, `.gitignore`,
`scripts/evaluation/*.mjs`, several `evaluation/` untracked dirs) were already
in the working tree before this thread of work started — see "Scope note"
below, do not fold them into this commit without checking with the user.**

## What we're working on

`agent-context-card` is a Pi coding-agent extension whose thesis is: an agent
can work with a much smaller context than "resend the whole conversation" by
tracking task state deterministically (see `AGENTS.md` at repo root for the
full mission/design). This thread started from a user report: "Pi gets stuck
using this extension, I have to run it without the extension to get work
done." Diagnosis proceeded in three stages across the conversation:

1. **Traced a real stuck session** (CoreApps repo,
   `2026-09-21T12-05-20-621Z_01a0c3db-3e6c-7550-952f-c3f475b63f46.jsonl`, read
   via DuckDB per the user's global `CLAUDE.md` instruction to use DuckDB CLI
   for JSONL analysis, not `Read`/`grep`). Found two separate stuck-behaviors
   in `src/pi/index.ts` (forced `update_card` tool_choice being ignored by the
   model; a near-duplicate-search hard block firing repeatedly) — these are
   real but were **not the root cause** and were **not touched** in this
   thread (see Scope note).
2. **Found the actual root cause**: `consumedByDisuse` in
   `src/core/projection.ts` was dropping read evidence within 1-2 rounds based
   only on "did any later text repeat this exact file path substring" —
   completely unrelated to whether a mutation had happened. Confirmed via
   `hotEvidence` audit data from the real session: 4 live file reads collapsed
   to 0 within ~3 minutes with **zero mutations** in between. The agent then
   had to keep re-discovering the same 4-5 files every few minutes for the
   entire 19-minute session and never made a single edit.
3. **User asked to try a model-based alternative** (`pypi.org/project/laya`)
   instead of the existing text-substring heuristic, after an earlier internal
   classifier attempt ("JVE") reportedly failed ~50% of the time (no trace of
   that attempt exists anywhere on disk or in this repo). Built a 155-example
   controlled evaluation against 5 real production sessions — **Laya was
   rejected** (see `docs/notes/laya-retirement-classifier-eval-2026-09-24.md`
   for full numbers), but the per-session breakdown from that eval revealed
   the real, deterministic, fixable pattern: `consumedByDisuse` accuracy is
   88-96% in sessions with at least one successful mutation, and 8-38% in
   sessions with zero mutations. **That's what got fixed.**

Hard constraint, explicit in `AGENTS.md`: this project's design philosophy
rejects semantic/heuristic-guessing or model-based context management in
favor of deterministic, event-driven logic ("Ideas considered and rejected as
defaults" — the "10M-parameter keep/drop classifier" was rejected on paper
for exactly this reason). The Laya evaluation is now real, current evidence
for the same conclusion — **do not revisit a classifier/model-based retirement
signal without materially different evidence than what's in the 2026-09-24
note.**

User's own explicit instruction that shaped the fix: **"first make retirement
logic centralized and then improve it."** Two-phase requirement, in that
order — do the mechanical de-duplication first (behavior-preserving, provable
via the existing test suite), only then change actual behavior.

## What we achieved

All verified with `bun x tsc --noEmit`, `bun x eslint .`, `bun x prettier
--check`, and `bun test` (168 pass / 0 fail, 612 `expect()` calls, up from
167/609 at the start of this thread) after every step below.

### Phase 1 — centralized the retirement logic (behavior-preserving)

`src/core/projection.ts` had four independent retirement-decision functions
(`consumedDiscovery`, `consumedReads`, `consumedByFinding`,
`consumedByDisuse`), three of which (`consumedReads`, `consumedByFinding`,
`consumedByDisuse`) hand-duplicated the same "has anything genuinely happened
since this round" (`graceObserved`) check, and all four duplicated the same
"don't retire what the current turn is actually asking about"
(`hasReferenceOverlap`) guard. Extracted:

- `hasLaterSuccessfulCall(allRounds, results, afterIndex, predicate?)` — the
  one shared grace-boundary check, optionally filtered by a predicate (e.g.
  `isMutation`).
- `withCurrentTurnGuard(consumed, allRounds, currentTurnText)` — the one
  shared current-turn-reference exemption.
- `consumedByTrigger(messages, currentTurnText, findTrigger)` — the shared
  shape behind `consumedReads` (trigger = a later mutation of the same path)
  and `consumedByFinding` (trigger = a later `update_card` finding citing the
  path as a source), which were structurally identical, just hand-duplicated
  with different trigger predicates.

Verified behavior-preserving: ran the full suite (167/167, identical to
baseline) after this step, before changing any actual rule.

### Phase 2 — the fix: gate `consumedByDisuse` on real forward progress

`consumedByDisuse` now also requires `hasLaterSuccessfulCall(allRounds,
results, round.index, isMutation)` — i.e. at least one successful mutation
*anywhere* after the read, not necessarily of that read's own path — before it
can retire anything at all. This directly targets the failure mode the Laya
eval quantified: disuse retirement is trustworthy once the session has
demonstrated real progress, and actively harmful before that (a
still-investigating session isn't "done with" a file just because the next
few rounds didn't happen to repeat its exact path string).

### A real pre-existing bug the stricter gate exposed and forced a fix for

Fixing the test fixtures for the above surfaced a genuine, independent,
pre-existing bug: `projectTurn`'s local re-derivation of retirement (used when
slicing a turn around an `update_card` checkpoint, or when re-processing an
old turn that has some globally-active evidence) only had a **must-include**
override (`activeRounds`, "the global full-transcript pass already vouched to
keep this round, so keep it even if the local slice's narrower view doesn't
see why"). It had **no equivalent must-exclude override**. So when a
checkpoint split a turn into prefix/suffix and the *trigger* for a global
retirement decision (e.g. a mutation) lived in the suffix, the prefix's local
recomputation — which can't see the suffix — would wrongly resurrect a round
the global pass had already, correctly, retired. Before this thread, that gap
was silently papered over: the old, ungated `consumedByDisuse` was so
promiscuous ("any later call at all is enough grace") that it almost always
also excluded such rounds locally, just for the wrong reason, producing the
right output by coincidence. Tightening the gate removed that coincidence and
made the gap real (one test failure:
`checkpoint retirement > a file mutated after the checkpoint leaves no stale
evidence across the collapse`).

Fixed by threading a `retiredRounds` set (the complement of `activeRounds`)
through the same plumbing `activeRounds` already uses — `projectContext` now
computes both and passes both through `turnActiveRounds`/`turnRetiredRounds`,
`prefixActive`/`prefixRetired`, `suffixActive`/`suffixRetired`, and
`projectTurn`'s candidates filter now excludes anything in `retiredRounds`
just as unconditionally as it includes anything in `activeRounds`. This is a
general fix, not special-cased to the mutation-gate scenario — it closes the
same gap for `consumedByFinding` and `consumedDiscovery` too, even though no
test currently exercises those cross-slice combinations.

### Test changes (`tests/projection-overlap.test.ts`)

- 4 existing "disuse retirement" / "reads via bash" tests updated to include
  an unrelated mutation in their fixtures (satisfying the new gate) so they
  keep testing what they originally intended to test (the
  referenced-again / current-turn-guard behavior), not the new gate itself.
- **New test**: `disuse does not retire anything before a mutation has
  happened anywhere in the session` — the direct regression test for the
  actual fix.
- The pre-existing `checkpoint retirement > a file mutated after the
  checkpoint leaves no stale evidence across the collapse` test needed no
  fixture change; it now passes because of the `retiredRounds` architectural
  fix.

### Scope note — what was NOT touched

`src/pi/index.ts` and `tests/pi-adapter.test.ts` had uncommitted diffs
**already present before this thread of work began** (visible in the
session's very first git-status snapshot). These implement the
`update_card`-nudge / forced-tool_choice / near-duplicate-hard-block machinery
diagnosed in stage 1 above. That machinery is real and was involved in the
originally-reported stuck session, but is a **separate, pre-existing body of
work** — nothing in it was changed by this thread, and it should not be
assumed reviewed, tested, or endorsed by anything in this doc. Don't fold it
into a commit for this projection.ts work without the user's explicit say-so.

## What's next

1. **Get the user's go-ahead and commit.** The user's last message before
   `/handoff` was literally "Want me to commit this, or do you want to look
   it over first?" — no answer was given yet. Don't commit without asking
   again if picking this up cold; the user may want to review the diff
   themselves first (`git diff src/core/projection.ts
   tests/projection-overlap.test.ts`).
2. **Decide what to do about the pre-existing `src/pi/index.ts` /
   `tests/pi-adapter.test.ts` diff.** It's unrelated to this thread but sitting
   in the same working tree. Ask the user whether it's in-progress work they
   want kept separate, or whether it should be committed (separately) too.
3. **Optional follow-up, not started**: the two *other* stuck-session
   mechanisms found in stage 1 (forced `update_card` tool_choice being
   silently ignored by some models; the near-duplicate-search hard block) are
   still live, undiagnosed-further bugs in `src/pi/index.ts`'s already-dirty
   working copy. Nothing here fixed or even fully investigated those — they
   were noted, not resolved. If the user wants them addressed, that's new work
   scoped separately from this doc.
4. **No further code changes are anticipated for the disuse-gating fix
   itself** — it's complete per the bar in "What we expect from it" below.

## How to do it

- Diff to review: `git diff src/core/projection.ts
  tests/projection-overlap.test.ts` (283 changed lines in projection.ts, 64 in
  the test file).
- Full validation command sequence (all must pass before any commit, per
  `AGENTS.md`):
  ```
  bun test
  bun x tsc --noEmit
  bun x eslint .
  bun x prettier --check .
  bun build index.ts --outdir dist --target node
  ```
  (`prettier --check` currently reports pre-existing warnings on ~93 unrelated
  files — none of them are `src/core/projection.ts` or
  `tests/projection-overlap.test.ts`, both of which are clean. Do not run a
  blanket `prettier --write .` as part of this commit; it would pull in
  unrelated formatting churn.)
- Key functions to know if extending this further, all in
  `src/core/projection.ts`: `hasLaterSuccessfulCall` (~line 170),
  `withCurrentTurnGuard` (~line 188), `consumedByTrigger` (~line 213),
  `consumedByDisuse` (~line 378, now gated on `isMutation`), `projectTurn`
  (~line 489, now takes a `retiredRounds` 4th param), `projectCheckpointedTurn`
  (~line 450, now takes and threads `retiredRounds`), `projectContext`
  (~line 710, now computes `retiredRounds` as the complement of
  `activeRounds` and threads `turnRetiredRounds` per turn slice).
- Laya evaluation reproducibility (if anyone wants to re-run or extend it):
  `evaluation/results/laya-disuse-eval-2026-09-24/` — `01-build-candidates.py`
  (pure stdlib, extracts read events + hindsight ground truth from real
  session JSONLs, no dependencies needed), `02-run-laya.py` (needs `pip
  install laya` in a fresh venv — pulls a ~650MB-800MB HF checkpoint on first
  run, ~3.5 min one-time load + ~1.3s/example on CPU), `03-compute-metrics.py`
  (pure stdlib, reads `results.json`, prints the tables in the note). Full
  write-up: `docs/notes/laya-retirement-classifier-eval-2026-09-24.md`.

## What we expect from it

- `bun test` must show 168/168 passing (not just "no failures" — check the
  count actually grew by 1 from the 167 baseline, confirming the new
  regression test is present and running, not skipped).
- `tsc --noEmit`, `eslint .`, and `prettier --check` on the two touched files
  must be clean.
- **Do not** re-loosen `consumedByDisuse`'s mutation gate to "fix" a future
  failing test without first checking whether the *real* bug is the same
  cross-slice `retiredRounds`-style visibility gap this thread found — that
  failure mode is easy to misdiagnose as "the gate is too strict" when it's
  actually "a local recomputation can't see a trigger that lives in a
  different turn/checkpoint slice." The general fix (threading
  `retiredRounds`) should mean this class of bug is now closed for
  `consumedByFinding` and `consumedDiscovery` too, but if a similar bug
  surfaces there, extend the existing `retiredRounds` plumbing — don't
  reach for a narrower special case.
- **Do not** treat the Laya evaluation as "model-based retirement doesn't
  work, full stop, forever." It's specific evidence against *this*
  zero-shot, generic-prompt, single-model attempt. If someone proposes trying
  it again, the bar is: does the new attempt address the calibration-collapse
  finding (Laya's probability didn't correlate with ground truth at all), not
  just re-run the same thing hoping for a better draw.
- This doc's own accuracy bar: if `src/core/projection.ts` changes again in a
  way that touches retirement rules, **update this doc** (or file a new one
  and link it) rather than leaving it to silently drift out of date — this
  doc almost certainly needs a follow-up update once the user decides on
  commit/no-commit and the `src/pi/index.ts` question above.
