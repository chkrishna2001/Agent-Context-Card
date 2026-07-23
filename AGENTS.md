# AGENTS

This file is both implementation guidance and durable project memory. Read it before changing context policy.

## Mission

agent-context-card is trying to prove:

> A coding agent can work seamlessly without resending its full conversation when the host preserves the active task, unresolved execution facts, and exact evidence whose useful lifetime has not ended.

The goal is not the smallest possible token count. The goal is the smallest sufficient working context. Context may grow during a complex active turn and should shrink only when observable lifecycle events make evidence replaceable.

This project was originally named pi-task-card. It was renamed because the useful abstraction includes task boundaries, evidence leases, execution facts, and provider-context projection, not only a visible card.

## What was tried first

The original implementation gave the coding model:

- a tool for maintaining semantic task state;
- archive search and archived-output readers;
- references and continuation instructions in the card;
- fixed live-context limits;
- character-offset pagination alongside Pi's line-offset file reader.

This turned context management into a second task for the model.

In the first Gemma A/B test:

| Metric                  | No extensions | Original active card |
| ----------------------- | ------------: | -------------------: |
| Duration                |        72 sec |              182 sec |
| Tool calls              |             8 |                   70 |
| Tool errors             |             1 |                   24 |
| File reads              |             2 |                   44 |
| File edits              |             2 |                    2 |
| Card update calls       |             0 |                   13 |
| Archive retrieval calls |             0 |                    9 |

The active run included 21 reads of src/popup.js, 16 of src/background.js, 7 of src/popup.html, invalid invented state events, and archive-offset confusion. A character offset was reused as a built-in reader's line offset, producing an attempt to read beyond a 308-line file.

Conclusion: model-facing bookkeeping and retrieval were causing attention loops, not solving continuity.

## Ideas considered and rejected as defaults

### Semantic tool-output cache

A semantic database could hold cold tool output, but it makes retrieval another model task. Related text is not necessarily the exact file version needed for an edit, and telling the model “you read this” does not supply the content.

Do not add semantic retrieval to the default path without controlled evidence that it improves behavior. It may be explored later as an optional cold-history feature.

### Small keep/drop classifier

A proposed 10M-parameter classifier could label content but could not extract and preserve the exact facts needed later. Training it would create a separate research problem, while deterministic session events already offer stronger signals.

The classifier direction was dropped.

### Fixed budgets

The earlier 16,000-character cap removed useful evidence even with a 128K-token model. Task complexity is not proportional to a fixed character count.

Do not introduce a default hard card or transcript character limit. Recent-turn configuration is policy, not a target size.

### Lossy compaction

This project does not summarize the complete conversation. It extracts deterministic facts and projects live evidence. Use “projection,” “retirement,” and “extraction,” not “compaction,” when describing the core behavior.

## Current design

The core is deterministic and platform-neutral.

### Task anchors

The first substantive request creates a task anchor. Follow-ups continue it while work is unsettled or continuation signals are present. Explicit unrelated-task language, or a settled unrelated request, creates a new anchor.

An unrelated task must not receive the preceding task's context.

### Completed turns

Completed older turns reduce to the user request and final assistant response. Intermediate tool history retires after it no longer belongs to active working evidence.

### Discovery retirement

Listings and searches retire after they lead to successful reads or mutations. Empty discovery may retire after the agent proceeds.

### Duplicate retirement

Exact repeated tool-call signatures collapse to the newest round. Never break tool-call/tool-result pairing.

### Evidence leases

A successful file read stays live as exact evidence. After a successful mutation of the same path, one later successful action provides a grace boundary; only then may the stale pre-mutation read retire.

This rule is central. Do not replace active source evidence with a filename, hash, or retrieval hint.

### Execution facts

The card derives verified changes, validations, and unresolved failures from tool results. A matching later success clears a failure. Reads and searches are not repeated in the visible card.

### Audit isolation

Projection audits are Pi custom session entries and must never enter model-visible context.

### No model-facing tools

The passive Pi adapter registers zero tools. A future change that registers a tool changes the product hypothesis and requires a new controlled A/B gate.

## Repository boundaries

- src/core must not import Pi or another host SDK.
- src/pi owns Pi message normalization and lifecycle hooks.
- New hosts require their own adapters.
- An adapter must not claim token savings unless the host can intercept or replace provider-bound context.
- Runtime dependencies should remain zero unless a measured requirement justifies one.

Current size:

- 1,793 TypeScript source lines;
- approximately 40 KB bundled;
- two Pi peer dependencies;
- zero runtime dependencies;
- thirty-two focused tests.

There is no copied pi-dcp source or runtime dependency. pi-dcp contributed only conceptual context-hook and tool-pairing ancestry.

## Latest four-turn proof

Test model: llama-cloud/gemma4:31b, thinking off.

Both sides used disposable copies, isolated session directories, Pi print mode, and continuation mode so all four prompts shared one session.

The turns covered:

1. code implementation;
2. documentation using prior task context;
3. validation and correction;
4. a new unrelated read-only task.

### Overall results

| Metric                | No extension | Context card | Change |
| --------------------- | -----------: | -----------: | -----: |
| Turns completed       |            4 |            4 |  equal |
| Provider requests     |           20 |           16 |   -20% |
| Input tokens          |      153,360 |       63,883 | -58.3% |
| Output tokens         |        1,354 |        1,005 | -25.8% |
| Maximum request input |       13,249 |       11,064 | -16.5% |
| Tool calls            |           16 |           12 |   -25% |
| Tool errors           |            2 |            0 |  -100% |
| Duplicate calls       |            1 |            0 |  -100% |
| Duration              |     2.22 min |     1.65 min | -25.7% |

### Input tokens by turn

| Turn           | No extension | Context card | Reduction |
| -------------- | -----------: | -----------: | --------: |
| Implementation |       47,224 |       46,998 |      0.5% |
| Documentation  |       32,586 |        8,170 |     74.9% |
| Validation     |       47,735 |        3,553 |     92.6% |
| Unrelated task |       25,815 |        5,162 |     80.0% |

Turns 2–4 together fell from 106,136 to 16,885 input tokens: 84.1% fewer.

The nearly equal first turn is a positive result. Active file evidence was retained instead of prematurely optimized away.

### Context-window behavior

Maximum actual provider input by turn:

| Turn | No extension | Context card |
| ---- | -----------: | -----------: |
| 1    |        9,710 |       11,064 |
| 2    |       11,422 |        3,288 |
| 3    |       12,267 |        1,941 |
| 4    |       13,249 |        2,156 |

The baseline grew monotonically. The card grew during implementation, then dropped at task-phase boundaries. The unrelated fourth turn correctly scoped itself to five original messages and projected three.

### Card growth

The card measured 415 characters at the end of turn 1, 595 after documentation, 633 after validation, and 310 after the unrelated-task reset. This is acceptable evidence-driven growth, not a fixed-budget target.

### Behavioral quality

- No file was read more than once in either run.
- The card run had zero tool errors and no duplicate tool calls.
- No card-maintenance or archive calls were available.
- Both runs completed all four tasks and built the project.
- The card run made the smaller implementation change and preserved an existing background fallback that the baseline removed unnecessarily.

## Automated cross-session smoke proof

The repository now has an isolated Pi A/B runner at
`scripts/evaluation/run.mjs`. It copies or checks out a workspace per variant,
runs ordered sessions, grades repository commands, hashes file changes, asserts
continuity invariants, and emits raw traces plus JSON and Markdown reports under
the ignored `.agent-context-card/e/` directory.

The first passing live run used `llama-cloud/gemma4:31b`, thinking off, on a
four-session plan, implementation, validation, and unrelated-task sequence. Both
variants passed `node --test counter.check.mjs` and changed only `counter.mjs`.

| Metric                | Baseline | Context card | Change |
| --------------------- | -------: | -----------: | -----: |
| Provider requests     |       16 |           13 | -18.8% |
| Provider input tokens |   24,457 |       21,717 | -11.2% |
| Output tokens         |      615 |          491 | -20.2% |
| Tool calls            |       12 |            9 | -25.0% |
| Tool errors           |        0 |            0 |  equal |
| Duration              |  71.14 s |      71.86 s |  +1.0% |

All card assertions passed: the plan was captured and promoted without a user
command, later sessions resumed revision 1 with zero cross-session hot evidence,
and the unrelated task inherited neither the task nor its plan. The provider
reported zero cost and cache tokens, so those metrics were recorded but were not
comparable.

The first attempt caught a real deterministic bug: “follow the previously
approved plan” was treated as a planning request. Planning detection now matches
explicit creation/revision intent, with a regression test. This is a single tiny
fixture and one model run; it proves the harness and continuity path, not broad
reliability. The protocol and full metric inventory are in
`docs/automated-multisession-evaluation.md`.

## First SWE-bench Verified pilot

The first pinned official pilot used `sympy__sympy-18211` with
`llama-cloud/gemma4:31b`, thinking off, split across fresh planning,
implementation, and review sessions.

| Metric                |   Baseline | Context card |      Change |
| --------------------- | ---------: | -----------: | ----------: |
| Official result       | unresolved |     resolved | card passed |
| Provider input tokens |  1,271,160 |      267,542 |      -79.0% |
| Provider requests     |         56 |           21 |      -62.5% |
| Output tokens         |      4,512 |        3,322 |      -26.4% |
| Tool calls            |         53 |           18 |      -66.0% |
| Tool errors           |          8 |            0 |       -100% |
| Duplicate calls       |          4 |            0 |       -100% |
| Inference duration    |   439.69 s |     287.95 s |      -34.5% |

The baseline produced helper files but no production-code change and failed the
official FAIL_TO_PASS test. The card patched `sympy/core/relational.py`; the
official evaluator applied it, passed `test_issue_18188`, passed all 54
PASS_TO_PASS tests, and marked the instance resolved.

The provider reported zero monetary cost and cache tokens, so provider input is
the available cost proxy. This is a one-task result, not a pass-rate estimate.
It is the first evidence that the multi-session policy can improve both
correctness and efficiency on a real benchmark task.

Benchmark integrity rules learned from this pilot:

- checkpoint every turn before starting the next session;
- terminate the complete Windows subprocess tree on timeout;
- exclude `.agent-context-card` state from submitted model patches;
- normalize evaluator patch transport to LF before Linux Docker application;
- treat a missing official per-instance report as an evaluation error;
- report official resolution and exact FAIL_TO_PASS/PASS_TO_PASS counts.

## Second SWE-bench Verified pilot

A completed `sympy__sympy-21930` rerun used
`llama-cloud/gemma4:31b`, thinking off, across fresh planning,
implementation, and review sessions.

| Metric                 |   Baseline | Context card |      Change |
| ---------------------- | ---------: | -----------: | ----------: |
| Official result        | unresolved |   unresolved |       equal |
| FAIL_TO_PASS pass/fail |        0/6 |          5/1 | card closer |
| PASS_TO_PASS pass/fail |       45/0 |         45/0 |       equal |
| Provider input tokens  |  1,094,429 |      286,995 |      -73.8% |
| Provider requests      |         37 |           20 |      -45.9% |
| Output tokens          |      4,975 |        2,195 |      -55.9% |
| Tool calls             |         34 |           17 |      -50.0% |
| Tool errors            |          4 |            0 |       -100% |
| Duplicate calls        |         10 |            2 |      -80.0% |
| Inference duration     |   555.43 s |     141.35 s |      -74.6% |

Both submissions applied and preserved all 45 PASS_TO_PASS tests. The baseline
made no production-code change. The card changed
`sympy/physics/secondquant.py` and passed five of six FAIL_TO_PASS tests, but
missed the required `AntiSymmetricTensor` LaTeX grouping in `test_Tensors`.
This is a valid efficiency win and partial correctness improvement, but an
official non-resolution. Across two official pilots, the card has one resolution
and one non-resolution; do not report this as a pass-rate estimate.

The first attempt at this task was invalid because the baseline timed out and
the card exhausted its provider session allowance. Its diagnostic metrics are
retained in `docs/automated-multisession-evaluation.md` and explicitly excluded
from performance claims. The runner now counts provider errors separately and
stops a variant after a provider-error response.

Sanitized claimable metrics and excluded diagnostics are stored in
`evaluation/results/evidence-ledger.json`. A regression test recalculates each
published percentage from the raw counts so README and article figures have one
machine-readable source.

Local lifecycle expansion found a same-session boundary bug: after a settled
planning turn, “Implement JIRA-789” was treated as a new task even though the
exact task ID matched, erasing the promoted plan. Matching exact IDs now force
continuation unless explicit unrelated-task language is present. Regression
coverage includes interrupted planning, ten completed turns, and rewind/tree
reconstruction.

## Ten-session mixed proof

On 2026-07-22, the `ai-inference-router/mycoder` Pi routing configuration
completed the checked-in ten-session mixed gate.

| Metric             | Baseline | Context card | Change |
| ------------------ | -------: | -----------: | -----: |
| Correctness        |     pass |         pass |  equal |
| Provider requests  |       48 |           34 | -29.2% |
| Tool calls         |       38 |           25 | -34.2% |
| Tool errors        |        4 |            0 |  -100% |
| Duplicate calls    |        3 |            0 |  -100% |
| Inference duration | 183.48 s |     151.30 s | -17.5% |

Both variants passed all six final tests and changed only `counter.mjs` and
`README.md`; production output was byte-identical. Every card continuity
assertion passed across two plan/implement/validate workflows, documentation,
review, and unrelated-task resets. The router reported no token or cost usage,
so those comparisons are unavailable. Because the route may choose providers
internally and exposes only the `mycoder` alias, do not attribute this result to
a specific underlying model family.

## GPT-5 Nano ten-session proof

The same mixed gate completed with
`ai-inference-router/openai/gpt-5-nano`, thinking configured off.

| Metric                  | Baseline | Context card | Change |
| ----------------------- | -------: | -----------: | -----: |
| Correctness             |     pass |         pass |  equal |
| Provider input tokens   |  189,460 |       78,395 | -58.6% |
| Total tokens            |  218,673 |      108,409 | -50.4% |
| Provider requests       |       64 |           44 | -31.3% |
| Output tokens           |   29,213 |       30,014 |  +2.7% |
| Reasoning tokens        |   23,782 |       25,856 |  +8.7% |
| Tool calls              |       55 |           34 | -38.2% |
| Tool errors             |        4 |            3 | -25.0% |
| Raw repeated signatures |        1 |            5 |  +400% |
| Same-state repeats      |        0 |            1 |    n/a |
| Inference duration      | 381.24 s |     333.99 s | -12.4% |

Both variants passed all six tests and every card continuity assertion passed.
The baseline added unrequested non-finite-number handling; the card made the
smaller boundary-only production change. Output and reasoning increased. The
raw repeated-signature counter rose from one to five, but trace analysis found
four legitimate post-edit rereads or test reruns; same-state repeats were zero
for baseline and one for the card, caused by a repeated malformed-path read.
Thinking was configured off, but the provider still reported reasoning tokens.
Preserve both the raw and state-aware metrics in future reports.

### GPT-5 Nano pooled repetitions

Three complete comparable pairs are available after pooling the original pair
with two complete pairs from a fresh repeated execution. Paired median changes
were -23.9% provider input, -16.3% total tokens, -29.1% requests, -33.3% tools,
and -0.4% duration. The observed provider-input range was -58.6% to +5.1%, so
input did not improve in every pair. Output rose in every pair (median +17.1%),
as did provider-reported reasoning (median +24.7%).

Baseline correctness was 3/3; card correctness was 2/3. The failed card run
passed all six production tests and all continuity assertions but did not perform
the requested README edit. Nano returned a new plan after receiving the correct
latest request alongside the full pinned plan and its plan marker. Treat this as
possible stale-plan dominance, not missing context, and do not claim that card
correctness has never been worse. Do not change plan lifecycle from this single
observation; test any phase-aware plan rendering or retirement rule as a
controlled variant with the README mutation as a correctness gate.

The fresh n=3 command exceeded its one-hour outer ceiling after three baselines,
two cards, and one turn of the third card. A complete unpaired baseline is
excluded from paired claims. Two fresh card recovery attempts ended with four
consecutive provider `Connection error` responses and are excluded. The runner
now checkpoints each completed run, reports repeated-run distributions, and can
select a variant/repeat for recovery.

## What is proved so far

The evidence supports:

- context need not grow monotonically with conversation length;
- exact active evidence can be preserved while achieving large later savings;
- deterministic retirement can reduce tokens, tool calls, errors, and duration;
- a small derived card can maintain continuity without becoming a second task;
- explicit task boundaries isolate unrelated work.

This is a strong proof of concept.

## What is not proved

Do not call the package production-ready yet. The evidence does not establish:

- reliability across many repositories;
- reliability across additional repositories, runs, and model families;
- correctness in very long sessions;
- resume, fork, undo, and tree-navigation robustness under live use;
- equivalent savings in hosts without context replacement.

The four-turn test also began from a dirty source repository. Both A/B sides had the same starting state, so the context comparison is fair, but it was not a pristine correctness fixture.

## Release gates

Before production:

1. rerun from a clean pinned Git snapshot;
2. assert expected source changes and artifacts automatically;
3. run at least ten mixed code, documentation, debugging, and unrelated turns;
4. test a large-context model and a smaller local model;
5. replay resume, fork, interruption, and tree-navigation cases;
6. verify failed evidence survives until matching success;
7. continue measuring actual provider tokens, not just projected characters;
8. audit every future host's real context-control capabilities.

## Release automation

npm publishing is tag-only. Do not run npm publish locally.

The repository contains:

- .github/workflows/ci.yml — validates pushes and pull requests;
- .github/workflows/publish.yml — validates and publishes version tags;
- CHANGELOG.md — Keep a Changelog release history;
- scripts/validate-release.mjs — validates semver, tag/version equality, and dated changelog sections;
- scripts/guard-publish.mjs — blocks publishing outside the tag workflow;
- .githooks/pre-commit — checks staged version and changelog changes together.

Enable the repository hook once after cloning:

    npm run setup:hooks

Release procedure:

1. Update package.json to the intended semantic version.
2. Move relevant Unreleased notes into a dated section named exactly for that version.
3. Update comparison links at the bottom of CHANGELOG.md.
4. Commit and let CI pass.
5. Create the matching tag, for example v0.2.0 for package version 0.2.0.
6. Push the tag. The publish workflow requires the tagged commit to be on main, repeats all validation, and publishes to npm.

Stable versions publish under the npm latest distribution tag. Semver prereleases publish under next.

A failed publish can be retried without moving or recreating its tag:

- use Re-run all jobs on the original failed Actions run; or
- use Publish npm → Run workflow and enter the existing version tag.

Manual dispatch still checks out the immutable tag, requires it to exist on main, and applies the same version and changelog validation. It cannot publish arbitrary branch contents.

The npm package must exist before npm trusted publishing can be configured. Bootstrap the first tag release with a short-lived granular npm access token stored as the GitHub repository secret NPM_TOKEN. Because this is a non-interactive direct publish, the bootstrap token must:

- have read/write package permission;
- cover all packages while the new package does not yet exist;
- have bypass 2FA enabled;
- use the shortest practical expiration.

A normal token without bypass 2FA fails with EOTP because a GitHub-hosted runner cannot complete npm's interactive OTP prompt. This bypass token is a one-time bootstrap mechanism, not the steady-state authentication design.

After 0.1.0 exists:

1. configure npm trusted publishing for user chkrishna2001, repository Agent-Context-Card, workflow publish.yml, allowing npm publish;
2. delete the NPM_TOKEN GitHub secret;
3. optionally configure npm publishing access to disallow traditional tokens.

The workflow already has OIDC permission and uses a compatible Node/npm version. It will automatically use trusted publishing after npm is configured.

## Development rules

- Preserve user changes and unrelated dirty-worktree files.
- Use apply_patch for source edits.
- Keep core policy deterministic unless a new experiment explicitly tests a model-based component.
- Add a regression test for every retirement-rule change.
- Never retire a successful file read merely because a newer unrelated tool call exists.
- Never retain an unresolved failure only in hidden audit metadata.
- Never add model instructions to maintain or restate the card.
- Report correctness and behavior alongside token savings.

Validation:

    bun test
    bun x tsc --noEmit
    bun x eslint .
    bun x prettier --check .
    bun build index.ts --outdir dist --target node

For the full narrative and protocol, see docs/design-and-evaluation.md.
