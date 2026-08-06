# Design history and evaluation

Date: 2026-07-20

## Executive summary

This project tests a specific proposition:

> A coding agent does not need its full transcript on every provider request. It needs the active task, unresolved execution facts, and source evidence whose useful lifetime has not ended.

The first implementation maintained a task card through model-facing tools and archived old output behind retrieval tools. It failed behaviorally: the model spent attention and tokens maintaining the context system instead of completing the user's task.

The current implementation is passive. It observes session events, applies deterministic evidence-lifecycle rules, injects a small derived card, and projects the transcript before each provider request. It does not call another model, require model-authored memory, or expose retrieval offsets.

The latest four-turn Gemma test reduced total provider input by 58.3%. Once the implementation turn completed, turns 2–4 used 84.1% fewer input tokens while still completing code, documentation, validation, and unrelated-task work.

## Project lineage

### pi-dcp

pi-task-card was inspired by context-management ideas also explored in pi-dcp, particularly provider-context hooks and preservation of tool-call/tool-result pairs. This extracted repository has:

- no runtime imports from pi-dcp;
- no retained pi-dcp source files;
- no pi-dcp package dependency;
- only conceptual ancestry.

### pi-task-card

The initial repository mixed model-maintained state, archive search, fixed live-context budgets, active-file tracking, compatibility modes, and a large Pi-specific entry point.

The proven passive behavior was extracted into this fresh repository without copying Git history. The result is under 1,000 TypeScript lines instead of approximately 2,235, with a small Pi adapter around a platform-neutral core.

## What failed in the original design

The first controlled A/B task asked Gemma to make a hard-coded batch-export delay configurable from a browser-extension UI.

| Metric                  | No extensions | Original active task card |
| ----------------------- | ------------: | ------------------------: |
| Duration                |    72 seconds |               182 seconds |
| Tool calls              |             8 |                        70 |
| Tool errors             |             1 |                        24 |
| File reads              |             2 |                        44 |
| File edits              |             2 |                         2 |
| Card update calls       |             0 |                        13 |
| Archive retrieval calls |             0 |                         9 |

The active design produced 21 reads of _src/popup.js_, 16 reads of _src/background.js_, 7 reads of _src/popup.html_, invalid invented task-state events, and repeated archive reads.

It also exposed two incompatible offset contracts. The archive reader used character offsets while Pi's built-in file reader used line offsets. The model reused a character offset as a line offset and attempted to read beyond a 308-line file. The offset was not useful task information; it was pagination machinery introduced by the extension.

The model was not simply bad at tools. The extension had created attractive new tools and repeated instructions, making context maintenance look like part of the user's task.

## Alternatives considered

### Semantic caching of tool output

The idea was to store tool results in a semantic database and let the model retrieve them later.

Potentially this can keep cold evidence out of normal requests. It is not the default because retrieval becomes another model-visible task, embeddings may return related rather than exact versioned text, and the archive experiment already showed that references encourage rereads. Telling a model that it previously read a file does not provide the exact content needed to modify it.

Semantic retrieval remains a possible optional cold-history experiment only after passive projection is proven.

### A 10M-parameter keep/drop classifier

A small classifier could label transcript items as important or disposable, but classification is not content extraction. It may say that an item matters without preserving the exact facts required later. Training and evaluating it would create a second research project, while tool and lifecycle events already provide stronger deterministic signals.

The classifier idea was dropped.

### “The file is stored in memory”

Replacing file content with a notice or database reference was rejected as the default because a reference is not evidence, file versions change after edits, and explicit retrieval attracts model attention.

The current design keeps exact read output hot until an observable event ends its useful lifetime.

### Fixed context limits

The earlier implementation used a 16,000-character live-context limit even with a model advertising a 128K-token window. That limit was unrelated to task complexity and removed useful reads prematurely.

The current design has no fixed card or transcript character budget. The recent-turn flag is a projection-policy control, not a target card size.

### Compaction

The project does not describe its behavior as conversation compaction. It extracts deterministic facts and projects still-live evidence. It does not rewrite the complete conversation into a lossy summary.

## Design principles

1. **Passive by default.** The coding model never maintains the card.
2. **Runtime facts over model claims.** User requests, tool calls, results, and task boundaries are the source of truth.
3. **Evidence has a lifecycle.** Retention depends on whether evidence can still affect the task.
4. **Exact evidence before references.** Active source content remains available.
5. **No arbitrary size target.** Minimal means justified by the task.
6. **Preserve valid tool pairs.** A retained tool call keeps its matching result.
7. **Failures remain until resolved.** A matching later success clears the failure.
8. **An explicit task switch outranks conversation age.** A `/card-new` or `/card-reset` starts clean; nothing else does — same-session task-switch inference proved unreliable in practice and was removed.
9. **Measure provider usage.** Card length alone does not prove savings.

## Current projection model

### Task anchors

One Pi session is one task anchor. The first substantive request creates it, and it holds for the life of the session; there is no heuristic that infers a topic switch mid-session and auto-resets it. A prior version tried to infer "unrelated" follow-ups from text (a continuation-word regex plus a vocabulary-overlap fallback); it produced two documented false positives in real sessions — one erased a promoted plan on an exact task-ID match, the other silently truncated context after a plain "yes, proceed" reply — so it was removed in favor of explicit resets only, via `/card-new` or `/card-reset`.

Anchors are stored as Pi custom session entries so resume and tree reconstruction can recover task identity without placing that metadata in model context.

### Completed turns

Older completed turns retain the user request and final assistant response. Intermediate narration, tool calls, and results retire once they no longer belong to the active working turn.

### Discovery

Listings and searches retire after they lead to a successful read or mutation. Empty discovery can retire after the agent proceeds.

### Duplicate rounds

Exact repeated tool-call signatures collapse to the newest round. This addresses loops without blocking tools or inventing an autonomous retry policy.

### Evidence leases

A successful file read creates a versioned evidence lease:

1. the exact output stays live;
2. a successful mutation of the same path marks it consumed;
3. one later successful action provides a grace boundary;
4. the stale pre-mutation read can retire.

The grace boundary prevents source evidence from disappearing immediately after an edit, before the model can observe and validate what happened.

### Execution card

The injected card includes only sections with data:

- task;
- latest request when different;
- project capabilities;
- unresolved failures;
- verified changes and validations.

It excludes reads, searches, generic file lists, archive references, and instructions to update the card.

### Auditing

Each projection can append an _agent-context-card-audit_ custom session entry containing original and projected counts, estimated tokens, card size, retirement reasons, active evidence versions, and context-window metadata.

Audit entries remain outside model-visible context.

## Architecture

The platform-neutral _src/core_ directory owns:

- _anchor.ts_ — task-boundary rules;
- _projection.ts_ — transcript projection and evidence leases;
- _execution.ts_ — changes, validations, and unresolved failures;
- _project.ts_ — deterministic project capabilities;
- _runtime.ts_ — card assembly;
- _format.ts_ — minimal rendering;
- _types.ts_ — normalized host-neutral contracts.

The _src/pi_ adapter owns Pi message normalization, context-hook integration, anchor and audit persistence, flags, status, and commands. It registers zero model-facing tools.

Future adapters should exist only when a host can intercept or replace provider-bound context. Pi provides direct context hooks. Claude Code, Codex, Cursor, and Antigravity each require a separate capability audit; merely injecting instructions cannot deliver equivalent token savings.

## Four-turn A/B protocol

Both runs used:

- llama-cloud/gemma4:31b;
- thinking disabled;
- separate disposable copies of the same repository;
- separate session directories;
- Pi print mode for non-interactive execution;
- continuation mode after turn one so all prompts shared a session.

The prompts were:

1. implement a UI-configurable batch-export request delay;
2. update the README without changing source code;
3. validate code and documentation and fix only related problems;
4. switch to an unrelated manifest-inspection task without modifying files.

The baseline used no extensions. The card run explicitly disabled discovered extensions and loaded only _agent-context-card/index.ts_. Each script printed its disposable worktree and session directory for later analysis.

## Four-turn results

### Overall

| Metric                 | No extension | Context card | Change |
| ---------------------- | -----------: | -----------: | -----: |
| Turns completed        |            4 |            4 |  equal |
| Provider requests      |           20 |           16 |   -20% |
| Provider input tokens  |      153,360 |       63,883 | -58.3% |
| Provider output tokens |        1,354 |        1,005 | -25.8% |
| Maximum request input  |       13,249 |       11,064 | -16.5% |
| Tool calls             |           16 |           12 |   -25% |
| Tool errors            |            2 |            0 |  -100% |
| Duplicate calls        |            1 |            0 |  -100% |
| Duration               | 2.22 minutes | 1.65 minutes | -25.7% |

### Per-turn provider input

| Turn               | Baseline total | Card total | Reduction |
| ------------------ | -------------: | ---------: | --------: |
| 1 — implementation |         47,224 |     46,998 |      0.5% |
| 2 — documentation  |         32,586 |      8,170 |     74.9% |
| 3 — validation     |         47,735 |      3,553 |     92.6% |
| 4 — unrelated task |         25,815 |      5,162 |     80.0% |

The first turn is intentionally close: active source evidence was preserved instead of optimized away. Turns 2–4 together fell from 106,136 to 16,885 input tokens, an 84.1% reduction.

### Maximum input context by turn

| Turn | Baseline |   Card |
| ---- | -------: | -----: |
| 1    |    9,710 | 11,064 |
| 2    |   11,422 |  3,288 |
| 3    |   12,267 |  1,941 |
| 4    |   13,249 |  2,156 |

The baseline grew monotonically. The card grew while implementation evidence was active, dropped at the next phase, and reset for the unrelated task.

### Card behavior

| Turn | Final estimated projected tokens | Card characters | Original messages | Projected messages |
| ---- | -------------------------------: | --------------: | ----------------: | -----------------: |
| 1    |                            8,911 |             415 |                15 |                  9 |
| 2    |                            1,867 |             595 |                21 |                  7 |
| 3    |                              523 |             633 |                25 |                  5 |
| 4    |                              528 |             310 |                 5 |                  3 |

Observed behavior:

- turn 1 retired three consumed discovery rounds while keeping three hot file reads;
- turns 2 and 3 retired completed-turn execution history;
- turn 4 created a new task boundary and excluded the previous task (this ran under the since-removed same-session boundary heuristic; a rerun today would need an explicit `/card-new` at turn 4 to reproduce the exclusion);
- no source file was read more than once;
- no card-maintenance or archive tools were available.

## Correctness review

Both runs completed all prompts, passed the repository build, passed the UI delay to the background worker, documented the 2000 ms default, and reported the correct manifest name and version.

The card run made the smaller change. It recognized that the background worker already consumed the delay and preserved its fallback. The baseline removed that fallback unnecessarily.

Both builds produced Chrome and Firefox artifacts and then reported the repository's existing Windows tar warning.

## Important limitation

The source repository was dirty before either disposable copy was made. It already contained the delay input, preference persistence, background delay use, and an untracked configuration file. Both tests therefore had the same starting state, making the context A/B comparison fair, but this was not a pristine end-to-end implementation fixture.

Future tests should start from a pinned commit or Git archive and apply a controlled fixture patch.

## What this proves

This run supports the central approach:

- context does not need to grow monotonically with conversation length;
- preserving full active evidence is compatible with large later savings;
- deterministic retirement can reduce tokens and agent activity;
- a small card can preserve continuity without becoming a second task;
- explicit boundaries prevent unrelated work from inheriting old context.

It does not yet prove reliability across repositories, model families, very long sessions, or hosts that cannot replace provider context.

## Release gates

Before calling the package production-ready:

1. repeat the A/B test from a clean pinned snapshot;
2. add assertions for source changes and generated artifacts;
3. run a mixed session of at least ten turns;
4. test both a large-context and smaller local model;
5. replay interrupted, resumed, forked, and tree-navigation sessions;
6. verify failure evidence survives exactly until matching success;
7. keep measuring provider tokens, not only projected characters;
8. audit the real capabilities of every future host adapter.

## Non-goals

- training a memory classifier;
- invoking a hidden summarizer after every turn;
- building an autonomous retry loop;
- blocking repeated tools;
- replacing exact active evidence with semantic references;
- keeping half of a large window merely because it is available;
- minimizing tokens at the expense of task completion.

The goal is the smallest sufficient working context, determined by evidence lifecycle and task boundaries.
