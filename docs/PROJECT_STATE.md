# Project state

Last updated 2026-10-13 by project wind-up.

## Purpose & shape

Passive Pi extension (`npm:agent-context-card`, v0.6.0) that projects provider-bound
context: keeps exact live evidence, retires replaceable tool output, and carries a
small derived card of execution facts. TypeScript, Bun, zero runtime deps. Core in
`src/core`, Pi adapter in `src/pi`, A/B harness in `scripts/evaluation/`. Validate with
`bun test`, `bun x tsc --noEmit`, `bun x eslint .`, `bun x prettier --check .`.
Full narrative: `AGENTS.md`, `docs/design-and-evaluation.md`.

## Done

- Deterministic projection: evidence leases, discovery/duplicate retirement, execution facts, recent-turn window.
- One session = one task anchor; `/card-new`, `/card-reset`.
- A/B harness with wire-verified provider settings, SWE-bench pilot tooling, evidence ledger.
- Measured: lower raw input, tool calls and errors across several models (see AGENTS.md).
- Measured: effective cost higher than baseline on caching providers (`docs/notes/prompt-cache-effect-2026-10-05.md`).

## In progress

Nothing. Project concluded 2026-10-13.

## Remaining

None planned. If revisited, the only open lever is cache-aware projection
(append-only history, retirement only at boundaries), gated on effective cost and
correctness, not raw input.

## Last session

Wound up the project: README status rewritten to concluded with the caching caveat,
this doc created. Handoff docs in `docs/plans/` are kept as the record of their threads
(notes and campaign scripts link to them); their status lines are frozen, not current.

## Next task

None.

## Decisions & gotchas

- Concluded because raw-input savings become +45% to +63% effective cost on caching providers (+530% on Haiku); cause is per-turn header churn and Pi's single Anthropic breakpoint landing on the volatile status block.
- Possible remaining niche: small/local models with short context and no cache discount. Unverified for very long sessions; a single turn is not capped.
- Model-facing memory tools caused attention loops (70 vs 8 tool calls); keep the adapter tool-free.
- Stubbed old turns (request + reply) made models skip tool calls; reverted (`docs/notes/stubbed-old-turns-2026-10-06.md`).
- Stale planning constraints ("do not modify files") dominated GPT-5 Nano implementation turns; scope-note did not fix it.
