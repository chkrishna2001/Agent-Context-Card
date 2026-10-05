# Retirement without a mutation (centralization, disuse gating, superseded reads)

**Status (2026-10-05): centralization and the disuse mutation gate are done,
verified, and committed (`0a9e91c`). The next step, "superseded reads"
(retire an older read once a later read of the same path returned identical
content), is analyzed and designed but NOT built; the user had not yet said
"go ahead". Working tree is clean, 163/163 tests pass at `4c441a6`+.**

## What we're working on

`agent-context-card` (a Pi extension; mission in `AGENTS.md`) must keep
context small by retiring evidence deterministically. The open gap is reads
that no mutation ever consumes: `consumedByDisuse` in `src/core/projection.ts`
only fires after some later successful mutation, so in zero-edit stretches
(review, validation, investigation) reads stay live. Two real triggers:

1. A stuck CoreApps session (`2026-09-21T12-05-20-621Z_01a0c3db-...jsonl`)
   where the agent re-read the same files for 19 minutes with zero edits.
2. 2026-10-03 kimi gate (`ollama-cloud/kimi-k2.7-code:cloud`,
   `pi-ten-turn-mixed.json`, n=3): all 6 runs passed `npm test` and file
   assertions, but card-r2 and card-r3 failed `zeroHotEvidence` on the
   unrelated-task turns. Verified for r3: the review turn read
   `counter.mjs` and `increment.check.mjs`, ran tests, made no edit, so both
   leases were still `active` at the first projection of `unrelated-package`.

Hard constraints: deterministic only, no classifier, no fixed budgets, never
retire evidence that may still be needed (`AGENTS.md`). Staleness decisions
live in `src/core/projection.ts` only ("Single source of truth for
staleness"). The user's order was: centralize first, then improve.

## What we achieved

Done, verified, committed (`0a9e91c`):
- **Centralization** in `src/core/projection.ts`: `hasLaterSuccessfulCall`,
  `withCurrentTurnGuard`, `consumedByTrigger` replace hand-duplicated checks.
- **Disuse gate**: `consumedByDisuse` requires a later successful mutation
  anywhere. Basis: 155-read replay of 5 real sessions, accuracy 88-96% with an
  edit, 8-38% without.
- **`retiredRounds` plumbing** (complement of `activeRounds`, threaded through
  `projectTurn`/`projectCheckpointedTurn`/`projectContext`), fixing a latent
  bug where a local slice resurrected a round the global pass had retired.
- Laya (model-based retirement) rejected: probability did not track ground
  truth (0.613 vs 0.619). Full write-up:
  `docs/notes/laya-retirement-classifier-eval-2026-09-24.md`. Do not retry
  without a fix for that calibration collapse.

Analysis done this session (replayed on the same 5 CoreApps sessions with
`evaluation/results/laya-disuse-eval-2026-09-24/04-zero-mutation-rules-eval.py`;
190 read events, the Laya note counts 155, so numbers are directional):
- **Rejected: retire prior-turn reads at the next user turn** unless that
  message names the file. Retires 150 reads; 109 (73%) were read or edited
  again later, far worse than the 24% base rate. Turn boundaries are not a
  safe signal without a mutation.
- **Proposed, lossless: superseded reads.** 144 of 190 reads were read again
  later. When the later read returned byte-identical content, the older copy
  is redundant by construction. Read characters freed per session: 61%, 46%,
  60%, 38%, 25%. Today's duplicate retirement only matches identical
  tool-call signatures within one turn, so these copies stay live across
  turns.
- This does NOT fix the kimi failure: those two reads were never re-read.

## What's next

1. Ask the user for the go-ahead on superseded reads (they were asked, no
   answer yet).
2. Implement `supersededReads` in `src/core/projection.ts` (see How).
3. Add regression tests with fault-injection in
   `tests/projection-overlap.test.ts`.
4. Replay the real session logs through the real `projectContext` (not the
   Python approximation) and confirm freed characters roughly match the 25-61%
   above.
5. Rerun the n=3 gates and compare: `pi-ten-turn-mixed.json` on
   `ai-inference-router/gemma4:31b` and `ollama-cloud/kimi-k2.7-code:cloud`.
6. Decide the `zeroHotEvidence` assertion on unrelated-task turns. It assumes
   the card knows a new task started; that detection was deliberately removed
   (`AGENTS.md`, "Task anchors"). Recommended: relax it for turns whose
   previous turn had no mutation, instead of forcing retirement.

Step 4 depends on 2-3; step 5 depends on 4.

## How to do it

- Add `supersededReads(messages, currentTurnText)` next to `consumedReads` /
  `consumedByFinding` / `consumedByDisuse`; union it into `globalDiscovery` /
  `globalStaleReads` / `globalFindingConsumed` / `globalDisused` in
  `projectContext`, and into the local filter in `projectTurn`'s `candidates`.
- Rule: a round is superseded only if it has reads and EVERY call in it is a
  successful read (`isReadLike`) whose path has a later successful read with the
  same result `text` hash (reuse the sha256 already used for `EvidenceLease.version`
  in `projectionDetails`). Whole rounds only, so tool-call/result pairing is
  preserved. Wrap with `withCurrentTurnGuard`.
- Add a `superseded` counter to `RetirementCounts` in `src/core/types.ts` and
  the zeroed literals in `projectContext` / `projectionDetails`; update tests
  that assert exact count structs.
- Run: `bun test`, `bun x tsc --noEmit`, `bun x eslint .`, `bun x prettier
  --check src/core tests`, `bun build index.ts --outdir dist --target node`.
  Do not run `prettier --write .`; ~90 unrelated files report warnings.
- Replay script: `python evaluation/results/laya-disuse-eval-2026-09-24/04-zero-mutation-rules-eval.py [sessions_dir]`
  reads `~/.pi/agent/sessions/--C--Users-chkri-source-repos-CoreApps--`, which is outside
  this repo and may not exist elsewhere; the committed `candidates.json` /
  `results.json` hold the Laya-era data only.
- Gate commands (outputs land in gitignored `.agent-context-card/e/`; regenerate,
  don't expect them):
  ```
  node scripts/evaluation/run.mjs --config evaluation/configs/pi-ten-turn-mixed.json --model ollama-cloud/kimi-k2.7-code:cloud --repeats 3 --output .agent-context-card/e/<name>
  node scripts/evaluation/run.mjs --config evaluation/configs/pi-ten-turn-mixed.json --repeats 3 --output .agent-context-card/e/<name>
  ```
  The second uses the config default `ai-inference-router/gemma4:31b`. Model
  ids and context windows come from `~/.pi/agent/models.json` (contains API
  keys; never print it whole).
- Inspect leases per turn: `duckdb` over `<run>/r2-N/s/*.jsonl`, rows with
  `customType='agent-context-card-audit'`, field `data.hotEvidence`. Check
  absence with `grep -c` on the raw file, not a truncated DuckDB display.

## What we expect from it

- Superseded reads must be provably lossless: identical content hash, later
  read still live, whole rounds only. Retiring anything on a similarity or
  turn-boundary heuristic is the failure mode measured above (73% wrong).
- `bun test` all green with new tests present (count grows from 163); each new
  test must fail when the rule is disabled (fault-inject).
- Gates must show no correctness regression versus baseline (npm test, file
  assertions, continuity) before any token saving is claimed. Single runs are
  not evidence; use n=3 and read the per-turn table for spikes.
- Do not loosen `consumedByDisuse`'s mutation gate to make a test pass, and do
  not add a second staleness notion outside `projection.ts`.
- This doc needs updating at the end of the next session: bump the status
  line, move built items from "What's next" into "What we achieved".
