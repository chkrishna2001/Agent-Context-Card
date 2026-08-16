# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-08-16

### Added

- `update_card`, a tool the agent calls to explicitly record durable pending
  items and findings (uncapped, full-replace semantics), replacing
  transcript-shape guesswork with agent-declared state.
- A `turn_end` nudge, capped at two consecutive misses, that prompts the
  agent when meaningful tool activity accumulates without an `update_card`
  call.
- A `before_provider_request` handler that forces `tool_choice` to
  `update_card` once activity crosses a threshold when the soft nudge goes
  unanswered, capped by its own streak counter and falling back to a safe
  no-op for any unrecognized payload shape.
- A steer message sent immediately after a forced `update_card` call
  resolves, telling the model the interruption wasn't a stopping point so
  it resumes acting instead of stopping mid-task.
- Automatic `consumedByDisuse` evidence retirement: a read nothing engages
  with again — no later assistant text, no later tool call — retires on its
  own, recomputed fresh against the full transcript every request.
- `sources` on `update_card` findings, so a read distilled into a finding
  retires once the finding survives a grace round (`consumedByFinding`).
- Bash-based file reads (a single unpiped `cat`/`head`/`tail`/`less`/`more`
  of one file) now recognized as reads for evidence lifecycle purposes,
  going through the same classification every other retirement mechanism
  uses.
- An explicit "no user is available to answer questions or confirm
  actions" note appended via `before_agent_start` when `ctx.hasUI` is
  false, so unattended runs stop waiting on a response that will never
  come.
- A repeated-identical-failure nudge: two consecutive calls with the same
  tool name and arguments that both failed trigger a steer nudge, capped
  at two per streak.
- A `ctx.hasUI`/`ctx.mode` audit line on every `before_agent_start` fire,
  for verifying extension activation inside a real harness invocation.
- Fixes for two SWE-bench eval harness crashes (unbounded stdout
  buffering; an empty patch misreported as a grading failure), with both
  checked-in pilots re-run on current code.

### Changed

- The card is now split into a stable leading message (goal, plan,
  capabilities) and a volatile trailing status message (findings, pending,
  filesRead, execution, resumed facts), extending prefix-caching to also
  cover findings/filesRead/pending.
- `projectContext` treats a successful `update_card` call as a checkpoint:
  everything before the most recent one in the current turn collapses,
  while hot-evidence protection still applies to anything referenced again
  after it.
- The rendered card uses flat goal/project/repo/what-happened/pending/
  findings/failures/files-read lines, replacing the tag-heavy format.
- Forcing `update_card` now also targets costly reads directly (over
  ~4000 chars) and validates substance, so a forced call with no real
  findings or pending no longer resets the nudge/force streaks as if it
  had resolved anything.

### Fixed

- A checkpoint-prefix read whose only later reference lived in the suffix
  is no longer locally misclassified as orphaned; local exclusion is now
  overridden by membership in the global `activeRounds` set.

## [0.3.0] - 2026-07-30

### Added

- Deterministic phase-limited-directive extraction that scans the durable
  plan body itself, not only the `## Process Notes` header, so a
  planning-only constraint (for example "do not modify files") retires at
  implementation start regardless of which section the model filed it under.
- A conservative reference-overlap guard in projection that keeps a
  discovery round or file read live for one extra turn when the current
  request still shares a path or term with it, instead of retiring purely on
  the existing trigger events.
- A card invariant linter (`src/core/invariants.ts`) that re-checks the
  assembled card immediately before formatting, strips any stale planning
  directive that still survived, and records every violation in the existing
  non-model-visible audit entry.
- A session-ID-keyed persistent card store (`src/pi/session-card-store.ts`),
  saved unconditionally on every settled turn and session shutdown, and
  consulted at session start whenever the session's own branch replay comes
  up empty.

### Changed

- Cross-session recovery is now keyed by the Pi session ID instead of a
  typed ticket-ID string, and is unconditional: a session no longer needs a
  message matching the task-ID pattern for its card to persist or resume.
  `TaskSnapshot.taskId` is now optional and used only as a display label.
- Persisted card state now lives under
  `%USERPROFILE%/.agent-context-card/cards/card-<sessionId>.json` (global)
  instead of `<repo>/.agent-context-card/tasks/<taskId>.json`
  (project-local).

### Removed

- The task-ID-typed cross-session bridge (`TaskStore`) and its
  `.agent-context-card/tasks/` file layout.

### Fixed

- Sessions that never included a ticket-ID-shaped string — most real usage —
  previously never persisted a card to disk at all, so the card was lost on
  any process restart. Saving is no longer gated on a typed task ID.

## [0.2.0] - 2026-07-24

### Added

- Automatic pinned-plan capture and visible plan revisions without
  model-facing or user-maintained card tools.
- Exact-ID, file-backed cross-session Pi continuity with atomic snapshots,
  schema validation, expiry, and isolated save/load audits.
- Repository provenance and explicitly historical rendering for resumed
  execution facts; evidence leases never cross session boundaries.
- Regression coverage for plan promotion, exact task IDs, corrupted state,
  prior-failure resolution, repository drift, and two-session plan resume.
- An isolated Pi A/B evaluation runner with correctness commands, workspace
  hashes, raw traces, per-turn provider/tool/timing metrics, projection audits,
  and machine-readable plus Markdown reports.
- A checked-in four-session continuity fixture covering plan, implementation,
  validation, and unrelated-task isolation.
- Pinned SWE-bench Verified inference and official Docker grading automation,
  including binary-capable patch export, per-turn checkpoints, Git mirrors,
  Windows process-tree timeouts, and exact FAIL_TO_PASS/PASS_TO_PASS reporting.
- A first real-repository pilot on sympy__sympy-18211: the card was officially
  resolved with 79.0% fewer provider-input tokens and 66.0% fewer tool calls;
  the no-extension baseline was unresolved.
- A second official pilot on sympy__sympy-21930: both variants were unresolved,
  while the card passed five of six FAIL_TO_PASS tests with 73.8% fewer
  provider-input tokens and 50.0% fewer tool calls.
- A checked-in evidence ledger with raw claimable metrics, excluded diagnostics,
  official test counts, and regression-checked percentage calculations.
- Regression coverage for ten completed turns, interrupted planning, and
  session-tree reconstruction.
- A checked-in ten-session mixed evaluation fixture and protocol covering two
  implementation tasks, documentation, review, validation, and task isolation.
- A passing live run of that gate through the `mycoder` routing configuration:
  29.2% fewer requests, 34.2% fewer tool calls, zero versus four tool errors,
  and 17.5% lower duration, with token usage unavailable.
- A passing GPT-5 Nano run of the same gate: 58.6% less provider input, 50.4%
  fewer total tokens, and 38.2% fewer tool calls, while output and reasoning
  increased; trace analysis isolated one same-state repeated malformed read.
- State-aware repeat metrics and repeated-run distribution reporting with
  medians, ranges, correctness counts, and paired percentage changes.
- A pooled three-pair GPT-5 Nano result: median reductions in provider input,
  requests, and tools, but 2/3 card correctness after one documentation turn
  returned a plan instead of editing README; provider aborts remain excluded.
- Per-run evaluation checkpoints plus targeted `--variant` and
  `--repeat-start` recovery controls for interrupted repeated gates.
- An opt-in phase-aware plan-projection experiment with mode/state audits and a
  focused four-session fixture. Its complete Nano n=3 result was negative:
  full-plan passed 3/3, phase-aware passed 2/3 and cost more at the median.
- A reproducible `eval:pi:nano-low` gate and runner-level `--thinking` override.
  The first controlled pair passed on both sides with 47.8% less provider input,
  64.9% fewer tools, and 13.7% fewer reasoning tokens for the card.
- A fresh controlled Nano-low n=3 with wire-level activation proof: all 264
  requests carried literal `reasoning_effort: low`. Baseline passed 3/3 and the
  card passed 0/3 because the pinned planning constraint “Do not modify files”
  dominated the later implementation request. Median token and tool reductions
  are retained as negative-result diagnostics, not product wins.- A controlled n=3 of the smallest scope-note intervention. The note activated
  on all 18 intended card turns and all 252 reconciled provider requests carried
  `reasoning_effort: low`, but correctness reached only 1/3 versus baseline 3/3.
  The failed traces still followed the verbatim no-edit constraint. The treatment
  remains opt-in and the result motivates structural separation of durable plan
  steps from phase-scoped process constraints.

### Changed

- `/card-reset` also closes the active task's stored continuity snapshot.
- Provider proxy work is deferred until the Pi/SWE-bench multi-session gate
  preserves correctness.
- Planning-intent detection now distinguishes requests to create or revise a
  plan from implementation language that merely refers to an approved plan.
- Matching exact task IDs preserve same-session plan-to-implementation
  continuity after a settled planning turn and across tree reconstruction.
- Benchmark submissions exclude private continuity state, and the Windows
  grader preserves LF patch transport into Linux evaluation containers.
- Post-planning `scope-note` framing is opt-in and disabled by default. Projection
  audits record its configured mode separately from activated framing state.
- Plan projection remains `full` by default; experimental `phase-aware` mode
  retires the plan body only after verified change and validation facts and now
  reports whether treatment state is `none`, `full`, or `retired`.
- Earlier GPT-5 Nano results are now labeled effort-uncontrolled: Pi requested
  `off`, but the router had not yet exposed `reasoning_effort`. Controlled Nano
  support maps only `none`, `minimal`, and `low`.
- Provider-sensitive gates now distinguish requested configuration from activated
  treatment. The Nano-low result is wire-verified at 97/97 requests; historical
  Nano, `mycoder`, and direct Gemma evidence is explicitly graded.
- Evaluation reports count provider errors separately from tool errors and stop
  a variant after a provider failure instead of recording misleading later turns.
- Interrupted benchmark metrics are retained as explicitly non-comparable
  diagnostics for future reporting and methodology articles.

## [0.1.0] - 2026-07-20

### Added

- Platform-neutral deterministic context-projection core.
- Thin Pi adapter with zero model-facing tools.
- Task anchors and unrelated-task isolation.
- Discovery, duplicate-round, completed-turn, and stale-read retirement.
- Versioned file-read evidence leases with a post-mutation grace boundary.
- Runtime-derived failures, changes, validations, and project capabilities.
- Provider-projection audit records stored outside model-visible context.
- Pi commands and configuration flags.
- Experimental core API export for researchers.
- Focused tests, product documentation, design history, and measured A/B results.

[Unreleased]: https://github.com/chkrishna2001/Agent-Context-Card/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/chkrishna2001/Agent-Context-Card/releases/tag/v0.4.0
[0.3.0]: https://github.com/chkrishna2001/Agent-Context-Card/releases/tag/v0.3.0
[0.2.0]: https://github.com/chkrishna2001/Agent-Context-Card/releases/tag/v0.2.0
[0.1.0]: https://github.com/chkrishna2001/Agent-Context-Card/releases/tag/v0.1.0
