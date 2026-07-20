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

- fewer than 1,000 TypeScript source lines;
- approximately 26 KB bundled;
- two Pi peer dependencies;
- zero runtime dependencies;
- nine focused tests.

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
- behavior across multiple model families;
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
