# SPEC: Pinned Artifacts & Cross-Session Task Continuity

Addendum to AGENTS.md. Read AGENTS.md first — this spec assumes and extends its
primitives (task anchors, evidence leases, execution facts, discovery retirement,
duplicate retirement, audit isolation, no-model-facing-tools) rather than
re-deriving them. Where this document is silent, AGENTS.md governs.

## Problem

Two gaps in the current design, both surfaced by walking a realistic ticket
workflow (plan → implement → test finds a bug → fix) through the existing
primitives:

1. **No durable plan.** Nothing in the current primitive set represents "the
   plan the user approved, which everything downstream should be checked
   against." A plan is not file evidence (it doesn't retire on mutation) and
   is not quite an execution fact either — it needs to be pinned: fully live
   for the whole task, replaced only by an explicit, visible re-plan.
2. **No cross-session continuity.** The current card is reconstructed from
   `sessionManager`'s branch, which is scoped to one session. A ticket that
   spans a plan session today and a bug-report session next week has no
   mechanism to resume with anything better than a blank card or a full
   session replay.

## Non-goals (read this before touching either feature)

This spec was almost written as "add a research-memory layer" and that would
have been wrong. Recording the correction here so the same mistake doesn't
get re-derived mid-implementation:

- **This is not memory.** Research memory is open-ended and accumulates —
  a rejected approach stays valuable indefinitely because re-litigating it
  is expensive. Task state is bounded — it should collapse to nothing once
  the ticket closes. Everything below must have a hard expiry. If an
  implementation detail doesn't have a clear end-of-life, it's out of scope
  for this spec.
- **No semantic or fuzzy matching, anywhere in this spec.** Consistent with
  AGENTS.md's rejection of semantic tool-output caching and the keep/drop
  classifier: task identification here is exact-string matching against an
  explicit ID, not similarity search. If exact matching proves insufficient
  later, that is a new, separately-gated experiment — not a default.
- **No new model-facing tools.** Same rule as AGENTS.md's "no model-facing
  tools" section. Pinned-artifact creation and cross-session save/load are
  triggered by deterministic session/lifecycle events and explicit user
  commands, never by an LLM-callable tool.

## New primitive: Pinned Plan

**Definition.** A pinned plan is the exact final assistant response from a
planning turn for the active task anchor. The host captures and promotes it
from the conversation lifecycle; neither the user nor the model maintains the
card. It stays fully live in context for the task anchor's entire lifetime.

**Rules:**

- Plan capture must not require a card-maintenance command. When the host
  exposes a planning-mode lifecycle event, that event identifies the final
  assistant response to capture. Otherwise the adapter uses a narrow,
  deterministic planning-request rule and captures the exact final assistant
  response from that settled, non-mutating turn as a candidate. Continuing the
  same task promotes the candidate before the next provider request. No model
  classifier or semantic judgment participates.
- A candidate may cross a session boundary so a plan-only session can be
  followed by an implementation session. It has the same task-close expiry as
  the pinned plan and is never presented as source evidence.
- A pinned plan is never silently overwritten or aged out. A later planning
  lifecycle event for the same task creates a replacement candidate. On
  continuation, the card identifies the promoted replacement by a monotonically
  increasing revision number (for example, `Plan (revision 2)`). This makes the
  change visible without retaining superseded plan text.
- Only the current plan is retained. This spec does not require keeping a
  history of superseded plans — that would be accumulative, research-memory
  behavior. (Flagged as an open question below in case a release gate
  proves this too lossy in practice.)
- A pinned plan does not participate in evidence leases, discovery
  retirement, or duplicate retirement. It has exactly one retirement event:
  task close.

## Resolved gap: Phase-scoped authority inside a pinned plan

The exact captured plan can mix two kinds of content:

- durable task facts and implementation/validation steps that remain applicable;
- process constraints scoped to the planning turn, such as “do not modify
  files,” whose authority ends when the user explicitly requests implementation.

The original specification did not distinguish them. A literal smaller model
therefore followed the stale no-edit constraint in three of three unframed card
runs. An appended deterministic post-planning disclaimer improved the observed
result to one of three but did not reliably override the verbatim body, because
it only stripped text the model itself filed under the `## Process Notes`
header — a directive written inside `## Plan` instead was never caught.

This is now solved without any silent retirement or summarization. Two
deterministic layers, both regex/string-based, no model classification:

1. `extractPhaseLimitedDirectives` (`src/core/continuity.ts`) scans the durable
   plan body itself — not only the `## Process Notes` header — for a negation
   ("do not", "don't", "avoid", "must not", "should not") combined with a
   mutation verb ("modify", "edit", "change", "touch", "write"). Any matching
   line is pulled out of the durable body and merged into `scopeNotes`
   regardless of which section the model wrote it under, then retires at
   implementation start the same way header-based scope notes already did.
2. `checkCardInvariants` (`src/core/invariants.ts`) re-runs the same check on
   the fully assembled card immediately before formatting, as a defense-in-depth
   backstop: if a directive somehow still survives in the durable body when the
   current request is not a planning request, it strips that line before the
   card is sent and records the violation in the existing non-model-visible
   audit entry (`invariantViolations` on the `agent-context-card-audit` entry).

Neither layer trusts the model's own bucketing decision — that was the actual
defect in the original disclaimer approach. Both are covered by regression
tests (`tests/continuity-plan-scope.test.ts`, `tests/invariants.test.ts`).

## Cross-Session Task Continuity

**Definition.** A file-backed state snapshot, keyed by the Pi session ID, that
lets a session recover its card after its own in-memory state and branch
replay are unavailable — most concretely, a process restart on the same
session — without treating stored state as open-ended memory.

An earlier version of this capability keyed the store by a user-typed
ticket ID instead of the session ID, requiring an exact match like `JIRA-123`
in the first message of a new session before anything would resume. In
practice this meant a session that never typed anything ticket-shaped — most
real usage — never persisted a card to disk at all, so it was lost on any
process restart. That mechanism has been removed; the design below replaced
it.

**What persists** (written at session end, and/or on every pinned-plan or
execution-fact change, whichever is simpler to implement correctly):

- the task anchor identifier and description
- the current pinned plan (current version only)
- a pending plan candidate, if the planning session ended before continuation
- current execution facts: verified changes, validations, unresolved
  failures — same shape as the in-session card already produces
- repository provenance for those execution facts: repository root, Git HEAD
  when available, and a deterministic working-tree fingerprint that excludes
  the continuity store itself
- remaining open items, if the design tracks these separately from
  execution facts

**What does not persist, and why:**

- **Evidence leases (file reads) do not carry across a session boundary.**
  A file read is only trustworthy as "live evidence" if nothing could have
  changed it since. Within one session that's a safe assumption; across a
  session boundary — possibly hours or days later, possibly after a
  teammate's commit or a CI run — it is not. Cross-session resume must
  start with zero live evidence and let the normal evidence-lease mechanism
  re-establish it through fresh reads. This is the single most important
  correctness rule in this spec; do not weaken it for efficiency.
- **Discovery history does not persist.** It's cheap to redo and stale
  discovery is actively misleading (a search from last week may no longer
  reflect the codebase).
- **Duplicate-call history does not persist**, for the same reason.

Persisted execution facts are historical claims, not live source evidence. On
resume, the card must label them as verified in a prior session. If repository
provenance differs, the card must also say that the repository state changed;
it must never present an earlier validation as a validation of the current
checkout. A later matching success may still resolve a persisted failure.

**Session resolution:**

- Resume activates unconditionally at `session_start`, whenever the
  session's own branch replay (`reconstruct()`) leaves the task anchor
  empty — concretely, a process restart on the same session, where Pi's own
  branch either wasn't available yet or didn't carry the custom continuity
  entries. It requires no message content from the user at all, typed
  ticket ID or otherwise.
- The lookup key is the exact Pi session ID (`sessionManager.getSessionId()`).
  A different session ID has no matching file and resumes nothing — this is
  a hard boundary, not a fuzzy one: two different sessions never share state
  even if their prompts happen to reference the same ticket text.
- The optional `taskId` field on a stored snapshot (still populated when the
  user happens to type a ticket-ID-shaped string) is carried through purely
  as a display label (`TASK ID: ...` in the rendered card) and plays no role
  in resolving which file to load.

**Storage:**

- One file per Pi session, `%USERPROFILE%/.agent-context-card/cards/card-<sessionId>.json`
  (`src/pi/session-card-store.ts`, `SessionCardStore`). Global, not
  project-local, matching where Pi stores its own session files. Plain file,
  no database, no new runtime dependency.
- Store structured state (JSON), not pre-rendered card text, so the
  existing card renderer stays the single source of truth for what the
  model actually sees. Rendering must always go through the same formatter
  used for in-session state, never a second, divergent formatter for
  resumed state.
- Snapshots have an explicit schema version and are written atomically through
  a sibling temporary file plus rename. A malformed snapshot is preserved (or
  quarantined) for diagnosis and is never silently overwritten as part of
  fail-closed recovery.

**Close / expiry:**

- `/card-reset` clears only the in-session card state; it deliberately keeps
  the stored snapshot on disk (there is no explicit delete command).
- The only expiry mechanism is an age-based garbage-collection pass, run at
  every `session_start`, that deletes card files untouched for more than 30
  days. This is intentionally the sole mechanism — closing must not depend on
  inferring "this seems done" from conversation content.

**Audit isolation still applies:** every save/load of cross-session state
must also produce a non-model-visible audit entry (same mechanism as
existing audit isolation), so a human can reconstruct exactly what state a
session resumed from if something looks wrong later.

## Development rules (additions to AGENTS.md's list)

- A pinned plan must never be treated as evidence subject to leases,
  discovery retirement, or duplicate retirement.
- Cross-session resume must fail closed: if the stored file is missing,
  malformed, or fails to parse, treat it as no match and start a fresh
  anchor. Never partially load or guess at corrupted state, and record the
  failed load in non-model-visible audit state.
- Never resume evidence leases from a stored file, under any circumstance.
- Add a regression test for every new resume-boundary case, same as the
  existing rule for retirement-rule changes.

## Release gates (additions to AGENTS.md's list)

1. Multi-session proof test, same rigor as the existing four-turn proof:
   plan approved in session 1; session 2 opens by referencing the task ID
   and reports a test failure; verify the card resumes with the plan and
   execution facts intact and zero stale evidence leases.
2. Explicit re-plan test: verify the card visibly shows the plan was
   revised, not silently replaced.
3. No-match test: a new session with no task ID, or an unrecognized one,
   behaves identically to today's baseline (no regression from this
   feature being present but inactive).
4. Corrupted/missing state file test: confirms fail-closed behavior per
   the development rule above.
5. Close/expiry test: confirms explicit close removes the file, and the
   GC safety net correctly leaves recently-touched task files alone.
6. Repository-drift test: facts from a different HEAD or working-tree
   fingerprint remain visibly historical and no earlier validation is
   represented as current validation.

## Evaluation order

The next proof runs on Pi, whose lifecycle and provider-context hooks already
isolate context policy from transport behavior. Use pinned SWE-bench tasks as
the primary correctness harness and split each issue across plan,
implementation, and validation/correction sessions. Compare correctness, real
provider tokens, tool behavior, failures, and duration against a no-extension
baseline.

SWE-Bench-CL sequences distinct tickets and therefore tests cross-ticket
learning rather than this spec's same-ticket continuity. It may later test task
isolation or a separately gated memory hypothesis, but state from a closed
ticket must not flow into the next ticket under this design.

Provider-wire proxies are deferred until the Pi multi-session proof preserves
correctness. Proxy work introduces independent session-identity, streaming,
authentication, caching, and protocol risks that would otherwise confound the
policy experiment.

## Open questions (intentionally unresolved — do not silently decide these mid-implementation)

- Should superseded plans be retained at all (even just the immediately
  prior version), or is current-only correct? Decide based on whether
  release-gate testing surfaces real cases where losing the prior plan
  hurts debugging or user trust.
- Which host planning signal or narrow planning-request syntax should each
  adapter recognize? The invariant is settled: capture is automatic and
  deterministic, never a user or model card-maintenance task.
- Concurrent access: what happens if two sessions reference the same task
  ID at the same time? Out of scope for the first implementation; at
  minimum it must fail safely (last-write-wins is acceptable for v1, but
  must be a stated, deliberate choice, not an accident of file-write order).
