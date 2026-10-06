# Retirement without a mutation (centralization, disuse gating, superseded reads)

**Status (2026-10-05): centralization, the disuse mutation gate (`0a9e91c`),
and Tier-1 lossless supersession (`supersededRounds`, UNCOMMITTED in the
working tree) are built and verified: 170/170 tests, tsc/eslint clean, new
tests fail when the rule is disabled. Real-session replay shows supersession
frees only ~0.03% of projected chars, so the real remaining weight is bash
output (see "What's next"). n=3 gates not rerun.**

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

Replay of 22 CoreApps sessions (`scripts/evaluation/replay-projection.ts`,
every 10th prefix, real `projectContext`): projected chars 13,971,255 before
vs 13,966,867 with supersession. Existing rules (2-turn window, mutation
consumption, in-turn dedupe) already catch what supersession targets. What is
live in the projection: bash results 63% (`rg -n` ~20%, `cd ... &&` chains
~6%, `find` ~7%, `git diff/status/show` ~9%, `dotnet build/test` ~5.5%), reads
36%. Searching for hit-line subsumption by later reads is a dead end: 0 of 17
plain rg/grep rounds were fully covered by a later read.

1. Commit the supersession change (rule is correct and harmless; low value).
2. Decide the next target on bash output. Candidates, each needs a lossless or
   self-correcting argument: search results retire only after any later read
   today needs a mutation (`consumedDiscovery`: `hasLater(isMutation)`);
   `rg | head`, `cd X && cmd` chains and `git` output are not recognized as
   discovery/read-like, so they are never retired by any rule.
3. Tier 2 (not started): retirement-regret pinning (a path re-read after
   retirement is exempt from disuse for the session) before extending disuse
   to zero-mutation stretches.
4. Measure prompt-cache effects before claiming savings on caching providers.
5. Rerun the n=3 gates (`pi-ten-turn-mixed.json`, gemma4:31b and kimi) only
   once a rule with real savings exists.
6. Decide the `zeroHotEvidence` assertion on unrelated-task turns: relax it
   when the previous turn had no mutation instead of forcing retirement
   (task-switch detection was deliberately removed; see `AGENTS.md`).

## How to do it

- Built as `supersededRounds(messages, retiredByOthers)` (generalized: any non-mutation tool, text containment, superseder must itself stay live, no current-turn guard because content remains in context); `RetirementCounts.superseded` added. Original sketch: `supersededReads(messages, currentTurnText)` next to `consumedReads` /
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
