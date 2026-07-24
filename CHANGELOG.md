# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/chkrishna2001/Agent-Context-Card/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/chkrishna2001/Agent-Context-Card/releases/tag/v0.2.0
[0.1.0]: https://github.com/chkrishna2001/Agent-Context-Card/releases/tag/v0.1.0
