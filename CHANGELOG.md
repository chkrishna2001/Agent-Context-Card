# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

### Changed

- `/card-reset` also closes the active task's stored continuity snapshot.
- Provider proxy work is deferred until the Pi/SWE-bench multi-session gate
  preserves correctness.
- Planning-intent detection now distinguishes requests to create or revise a
  plan from implementation language that merely refers to an approved plan.
- Benchmark submissions exclude private continuity state, and the Windows
  grader preserves LF patch transport into Linux evaluation containers.

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

[Unreleased]: https://github.com/chkrishna2001/Agent-Context-Card/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/chkrishna2001/Agent-Context-Card/releases/tag/v0.1.0
