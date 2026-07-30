# agent-context-card

**Keep coding agents focused as sessions grow.**

agent-context-card is a passive context-projection extension for Pi. It keeps exact evidence while it is useful, retires it when observable lifecycle events make it replaceable, and prevents unrelated tasks from inheriting old context.

> **Measured result:** 58.3% fewer provider input tokens in a four-turn Gemma A/B run, with 25% fewer tool calls and zero tool errors in the card-enabled session.
>
> **Two SWE-bench Verified pilots:** on sympy__sympy-18211, the card resolved
> the task with 79.0% fewer provider-input tokens while the baseline was
> unresolved. On sympy__sympy-21930, both were unresolved, but the card passed
> 5/6 FAIL_TO_PASS tests versus 0/6 for the baseline with 73.8% fewer input
> tokens. Two tasks are not a pass-rate estimate.

## Why use it?

Long coding sessions repeatedly send old searches, file reads, tool output, and completed work back to the model. This increases input usage and can eventually trigger lossy compaction.

Common alternatives introduce their own tradeoffs:

- summaries can drop exact implementation details;
- semantic memory asks the agent to notice and retrieve missing evidence;
- fixed limits ignore task complexity;
- model-maintained memory turns bookkeeping into another task.

agent-context-card takes a different approach:

- **No extra model calls.** Projection is deterministic and local.
- **No memory tools.** The agent keeps working with its normal tools.
- **Exact active evidence.** Useful file reads remain verbatim.
- **No arbitrary character cap.** Context follows task complexity.
- **Inspectable decisions.** Retirement metrics stay outside model context.
- **Automatic task isolation.** Unrelated work starts with a clean task scope.
- **Automatic session continuity.** The card persists per Pi session and
  recovers plans and historical execution facts across a process restart on
  the same session, without carrying stale reads and without typing a ticket
  ID.

## Install

Install the npm package through Pi:

    pi install npm:agent-context-card

Then start Pi normally. The extension works without configuration.

Try it for one run without installing:

    pi -e npm:agent-context-card

For a controlled extension-only test:

    pi --no-extensions -e npm:agent-context-card

Until the first npm release is published, install directly from GitHub:

    pi install git:github.com/chkrishna2001/Agent-Context-Card

Project home: [github.com/chkrishna2001/Agent-Context-Card](https://github.com/chkrishna2001/Agent-Context-Card)

## What changes in the model context?

| Kept while useful                             | Retired when consumed                         |
| --------------------------------------------- | --------------------------------------------- |
| Current task, latest request, and pinned plan | Superseded directory listings and searches    |
| Exact active file-read output                 | Exact duplicate tool rounds                   |
| Valid tool-call/tool-result pairs             | Intermediate history from completed turns     |
| Unresolved failures                           | Pre-edit file versions after a grace boundary |
| Verified changes and validations              | Context from an unrelated prior task          |

The model receives a small derived card plus the projected live transcript. It is never asked to update or restate the card.

Cross-session continuity is automatic and keyed by the Pi session ID, not by
anything the user types. A planning request captures the agent's exact final
plan automatically; the same session promotes it into the card. If a
session's own branch replay comes up empty at start — for example after a
process restart — the card recovers from a stored snapshot for that exact
session ID. Stored execution facts are labeled as prior-session facts, and
file-read evidence is never resumed. State is kept under
`%USERPROFILE%/.agent-context-card/cards/`. `/card-reset` clears only the
in-session card state and keeps the stored snapshot.

```mermaid
flowchart LR
    A[Pi session events] --> B[Normalize]
    B --> C[Task and evidence lifecycle]
    C --> D[Provider-bound context]
    C --> E[Audit metadata]
    E -. never sent to model .-> F[Session log]
```

## Evidence so far

The same four-turn coding workload was run with no extensions and with only agent-context-card.

| Metric                | No extension | agent-context-card |     Change |
| --------------------- | -----------: | -----------------: | ---------: |
| Provider input tokens |      153,360 |             63,883 | **-58.3%** |
| Provider requests     |           20 |                 16 |       -20% |
| Tool calls            |           16 |                 12 |       -25% |
| Tool errors           |            2 |                  0 |      -100% |
| Duration              |     2.22 min |           1.65 min |     -25.7% |

The implementation turn retained essentially the same amount of evidence. Across the later documentation, validation, and unrelated-task turns, input usage fell by **84.1%**.

This is a research preview, not a universal performance claim. Read the [design history, full protocol, per-turn data, limitations, and release gates](docs/design-and-evaluation.md).

### Automated cross-session evaluation

Run the isolated Pi baseline/card smoke test with:

    bun run eval:pi

A checked-in ten-session mixed gate adds planning, implementation, validation,
documentation, review, and unrelated-task boundaries:

    bun run eval:pi:ten-turn

It grades a real failing test, verifies workspace hashes and continuity
invariants, and captures provider, tool, timing, session, projection, and task
state metrics. The finalized live run preserved correctness while reducing
provider input by 11.2%, requests by 18.8%, and tool calls by 25.0%; duration was
effectively flat at 1.0% slower. See the [automated protocol and full result](docs/automated-multisession-evaluation.md).

The ten-session mixed gate also passed on both sides with the
`ai-inference-router/mycoder` route. The card used 29.2% fewer provider
requests, 34.2% fewer tool calls, had zero versus four tool errors, and completed
17.5% faster. The router did not report token usage, so no token comparison is
claimed for this run. Pi declared the alias `reasoning: false`, and all 107
audited router requests omitted `reasoning_effort`; effort is not applicable to
this result.

The first, effort-uncontrolled `openai/gpt-5-nano` pair passed on both sides:
the card used 58.6%
less provider input, 50.4% fewer total tokens, 31.3% fewer requests, and 38.2%
fewer tool calls. Trace analysis later classified four of its five raw repeated
signatures as valid post-edit rereads or revalidation; same-state repeats were
zero for baseline and one for the card.

Across three pooled Nano pairs, median card changes were -23.9% provider input,
-29.1% requests, -33.3% tools, and -0.4% duration. Ranges were wide: provider
input varied from -58.6% to +5.1%, while output and reported reasoning rose in
every pair. Baseline correctness was 3/3 and card correctness was 2/3. The failed
card run passed production tests and continuity checks but returned a plan
instead of making the required README edit. This possible stale-plan-dominance
failure is now an explicit experiment target, not hidden negative evidence.

After the router gained reasoning-effort support, an explicitly controlled
`low`-effort pair passed on both sides and all 20 Pi sessions recorded `low`.
The 97 provider requests in the report matched 97 router logs, all carrying
literal `reasoning_effort: low`. The card used 47.8% less provider input, 44.7%
fewer total tokens, 55.2% fewer
requests, 64.9% fewer tools, and 13.7% fewer reasoning tokens; duration fell
18.7%. The baseline overwrote most of README and added a package lock, while the
card preserved the README structure and added no artifact. This is a single
controlled pair, not a reliability estimate. A subsequent fresh controlled n=3
reversed the correctness picture: baseline passed 3/3 and the card passed 0/3.
All 264 report requests reconciled to 264 router logs carrying literal
`reasoning_effort: low`. The card reduced provider input by 35.7%, requests by
42.4%, and tools by 52.0% at the paired median, but those savings are not a
positive product result because every card run left the required increment fix
broken. In all three, Nano received the implementation request alongside the
exact pinned plan containing “Do not modify files,” returned another plan, and
declined the edit. This reproduces a narrower defect: verbatim carryover of a
planning-only constraint is unsafe for Nano on this fixture; durable plan steps
were not shown to be the problem.

A surgical follow-up retained the exact plan and added an explicit post-planning
scope note. The note activated on all 18 intended card turns, and all 252 report
requests matched router logs carrying `reasoning_effort: low`. Correctness
improved from 0/3 to 1/3 but remained below the 3/3 baseline. Provider input fell
27.5% and tools 48.8% at the paired median, while output rose 45.7%, reasoning
rose 28.5%, and duration was 1.7% slower. Both failed traces explicitly
re-adopted the verbatim no-edit constraint, so the note is insufficient and
remains opt-in research only. The next design gate must structurally separate
durable plan steps from phase-scoped process constraints.

A subsequent n=3 experiment compared the default full plan with an experimental
phase-aware projection. Full-plan passed 3/3; phase-aware passed 2/3 and used
58.8% more provider input, 20.8% more requests, and 30.0% more tools at the
paired median. The candidate failure occurred before plan retirement activated,
so it does not prove retirement caused harm—but it provides no basis to change
the default. Projection audits now distinguish configured mode from actual
`full` or `retired` plan state.

### Official SWE-bench Verified pilots

| Task               | Baseline   | Context card | Card input change | Card tool change |
| ------------------ | ---------- | ------------ | ----------------: | ---------------: |
| sympy__sympy-18211 | unresolved | resolved     |            -79.0% |           -66.0% |
| sympy__sympy-21930 | unresolved | unresolved   |            -73.8% |           -50.0% |

For the second task, the card passed 5/6 FAIL_TO_PASS tests while the baseline
passed 0/6; both preserved all 45 PASS_TO_PASS tests. This is useful negative
evidence, not a card resolution. Exact counts, timings, excluded interrupted
runs, and article-ready raw metrics are kept in the checked-in
[evidence ledger](evaluation/results/evidence-ledger.json).

## Commands and configuration

| Command                | Purpose                              |
| ---------------------- | ------------------------------------ |
| /card                  | Show the current derived card        |
| /card-new &lt;goal&gt; | Start an explicit task               |
| /card-reset            | Clear the active card; keep snapshot |
| /card-stats            | Show the latest projection metrics   |

| Flag                                             | Default | Purpose                                                 |
| ------------------------------------------------ | ------: | ------------------------------------------------------- |
| --context-card-recent-turns &lt;n&gt;            |       2 | Recent user turns eligible for projection               |
| --context-card-audit on\|off                     |      on | Persist non-content projection telemetry                |
| --context-card-plan-projection full\|phase-aware |    full | Experimental plan rendering; keep `full` for normal use |

The adapter registers zero model-facing tools.

## For researchers

The projection engine is platform-neutral and available as an experimental package export:

```ts
import {
  projectContext,
  type ContextMessage,
  type ProjectionResult,
} from "agent-context-card/core";
```

Normalize a host transcript into ContextMessage values, call projectContext, and translate the returned raw messages through the host's provider-context hook.

Pi is the reference adapter because it can directly replace provider-bound context. Claude Code, Codex, Cursor, and Antigravity require separate capability audits; adding instructions alone cannot produce equivalent savings.

## Safety and privacy

Projection runs locally and makes no additional provider requests. Pi still sends model-visible prompts, file contents, and tool results to the model provider selected by the user. Review provider data policies before using any coding agent with private source code.

## Development

Requires Node.js 22.19+ and Bun for repository development.

    bun install
    bun test
    bun x tsc --noEmit
    bun x eslint .
    bun x prettier --check .
    bun build index.ts --outdir dist --target node

Current validation: 34 focused tests, strict type checking, linting,
formatting, and production bundling.

## Releases

Releases are published to npm only from version tags after CI and changelog validation. See [CHANGELOG.md](CHANGELOG.md) for release notes and [AGENTS.md](AGENTS.md) for the maintainer procedure.

## Status

**Research preview.** The evidence is a strong proof of concept. Repeated
broader-repository runs and live fork/interruption/tree-navigation gates remain
before a production-ready claim.

Licensed under MIT.
