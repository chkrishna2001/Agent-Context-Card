# Strategy notes — 2026-08-14

Captured from a working session investigating why P4-03 (EstimateStudio) kept
failing, and what agent-context-card should do next. Not a decision record,
just the points worth not losing.

## What we found this session

- Original P4-03 run (minimax-m3, routed via `mycoder`): 134 requests, purely
  `bash`/`read`, zero edits. Session ended mid-"let me start" with no tool
  call. Not caused by the card — no pinned plan, no `sources`, nothing to
  pin it on. Looked like plain analysis-paralysis on an oversized task.
- Rerun after landing two card fixes (below), same repo state, `mycoder`
  again: this time it actually edited code (8 successful edits). But the
  backend model silently changed too (`minimax-m3` → `glm-4.7-flash` — the
  router isn't a fixed model), so this is not clean evidence the fixes
  caused the improvement.
- Rerun again with a genuinely pinned model (`openrouter-pinned` /
  `openai/gpt-5-nano`), same starting state: zero edits again. Proximate
  cause this time was concrete: it read a minified Angular build bundle
  (`web/dist/.../chunk-*.js`), which alone pushed context usage from ~92%
  to ~96% of its (128K) window, and its very next response came back empty
  (`stopReason: "length"`) — it ran out of room before it ever got to
  decide whether to edit.
- Across all three: `retired.findingConsumed` stayed 0. Neither model, in
  any run, ever populated `findings[].sources` on `update_card`, so the new
  finding-sourced retirement mechanism has zero live evidence yet, positive
  or negative.

## Two fixes landed this session (both tested, both live-confirmed for A)

- **Task A**: `formatContextCard` no longer lists `filesRead` entries whose
  state is `"active"` — those are already fully visible in the live
  transcript, so repeating the path was pure redundant token cost. Confirmed
  live in both reruns (card correctly omitted the line when all evidence was
  active).
- **Task B**: `update_card` findings can carry an optional `sources: string[]`.
  A read cited by a later finding's `sources` becomes eligible for
  retirement after a grace round, mirroring the existing mutation-consumption
  path. New `findingConsumed` retirement counter. Unit-tested rigorously
  (including a fault-injection check: disabled the wiring, confirmed the new
  test failed, restored it). No live evidence yet either way — see above.

## Three next-step ideas I proposed, and why they were rejected

1. **Round-based staleness fallback** ("no mutation after N rounds →
   stale"). Rejected: this is a timer, the same class of arbitrary cutoff
   the project's own README explicitly argues against ("fixed limits ignore
   task complexity"). It would retire evidence that's still relevant just
   because N rounds passed, and keep irrelevant evidence if they haven't.
2. **Guard against oversized/build-artifact reads** (denylist `dist/`,
   `.min.js`, size thresholds). Rejected: special-cased to one failure we
   happened to observe. "Today it's this repo, tomorrow it's something
   else" — doesn't generalize, and we can't maintain a list of every kind of
   large-but-unhelpful content a coding agent might read.
3. **Lean harder on the existing eval harness** (`bun run eval:pi:ten-turn`,
   `evaluation/configs/*`) instead of more one-off manual `pi -p` trials.
   Directionally right for controlled comparison, but still a curated
   benchmark — not evidence from real usage.

## The reframe: think bigger

The project's own stated design principle is to act only on **observable
lifecycle events** (a mutation happened, the agent called `update_card`, a
new turn started) — never arbitrary limits, never extra model calls. Both
rejected ideas above quietly violated that principle by inventing a new
special case (a clock, a denylist) instead of finding the general,
already-latent signal.

The unifying diagnosis: the unbounded-reads problem and the oversized-single-
read problem are the same problem stated twice — **evidence enters context,
and nothing observes whether it was ever actually used again.** Mutation-
consumption and finding-citation are two specific instances of "this got
used." A third, more general instance is already sitting unexploited in the
transcript: `hasReferenceOverlap`/`terms()` (in `projection.ts`) already
computes whether text overlaps with a piece of evidence — today it's only
ever pointed at the *current* live turn's text, to decide whether to *exempt*
something from retirement. Pointed forward across the whole transcript
instead, it becomes a deterministic, zero-extra-calls signal of
non-engagement: did any later assistant text, tool call, or finding ever
reference this evidence again? If nothing ever came back to it, that's a
real fact regardless of how many rounds passed (not a timer) and regardless
of what kind of file or output it was (not a denylist).

Second thread, orthogonal to the mechanism: the benchmark-vs-real-tests
point. What I did by hand this session — pull a session log, work out how
much of it was reads nobody ever came back to — is itself a deliverable.
Packaging that as a standalone, offline analysis anyone can run against
**their own** existing session logs (no live extension required) would let
the community see the token-waste problem is real from their own usage,
not from a curated benchmark we ran ourselves. DuckDB surfaced a stack of
the user's own real EstimateStudio dev sessions (Aug 2, Aug 12) sitting
right there as exactly that kind of real material.

## main vs. this branch, checked directly in code (not assumed)

`main` already had the context card *and* the projection engine before this
branch existed — `format.ts`/`RuntimeCard` are not new. What main's
`RuntimeCard` does NOT have: `findings`, `filesRead`/`hotEvidence`. Main's
projection.ts has no `isUpdateCardCall`, no checkpoint mechanism, no
`consumedByFinding` (obviously — that's this session's addition). Main's
card is built entirely from mechanically observable facts (goal, pinned
plan text, an execution journal built by scanning tool calls, capabilities
sniffed from package.json, resumed cross-session facts) — nothing in it is
the agent's own interpretation. Main decides what raw transcript to forward
purely from `consumedReads`/`consumedDiscovery`/turn-boundary collapse —
automatic, no agent cooperation needed.

This branch (`bc9bbf3` "Add self-maintained context card: agent-declared
findings replace guesswork", plus `e7b46ff` forcing it via tool_choice)
adds a genuinely different bet on top of the same base engine: let the
agent self-report conclusions (`findings`, now `sources`) via `update_card`,
and let those self-reports both stand in for retired evidence *and* (via
the checkpoint mechanism) trigger more aggressive collapse of everything
before them. This is additive — main's mechanisms are all still running
underneath — but the branch's whole thesis rests on the agent actually
using `update_card` well.

**The forcing mechanism already exists, and we have live evidence on how
well it works.** `CARD_ACTIVITY_NUDGE_THRESHOLD = 10` triggers a soft nudge;
if unanswered, `tryForceUpdateCardToolCall` forces the tool via
`tool_choice`, capped at `CARD_NUDGE_STREAK_CAP = 2` before backing off
until the next successful call resets it. Across the two live sessions run
*after* `sources` existed (`b198b128`, `f6e27b58`), `update_card` WAS
called (2x, 1x) — the forcing works, in the sense that the tool gets
invoked. But the content was thin every time: one call carried
`findings: []`, another only `pending`, none carried `sources`. **Forcing
compels compliance with the form (call the tool) but not the substance
(write a real finding, cite real sources).** That's a specific, now-observed
weakness of this branch's central bet, not a hypothetical one.

## Answered: is "point reference-overlap forward" actually proposing main's approach?

Yes, in kind. It's an automatic, transcript-only signal that doesn't
depend on the agent doing anything right — same category as main's
`consumedReads`/`consumedDiscovery`, not the same category as this branch's
`findings`/`sources` (which need agent cooperation, and empirically don't
reliably get it even when forced). It wouldn't have to replace anything —
it could sit alongside `consumedByFinding` as a third trigger in the same
family. But the real strategic question it raises: given three live trials
never produced a populated `sources` field even with forcing active, should
agent self-reporting remain the *primary* mechanism this branch is betting
on, or should it become an opportunistic bonus layered on an automatic
safety net that works with or without the agent's cooperation?

## User's next input: caching split + how to actually get summaries

**Branch thesis, stated precisely:** send the context card on every LLM
call, split into two messages for prompt-caching:
1. Constant: goal, project info — rarely changes, should stay cache-hit
   across many requests.
2. Variable: findings, reads, sources — changes often, currently forces a
   full-card re-hash (and cache miss for everything after it) on every
   change, because `formatContextCard` emits one monolithic string today.
This is a real, concrete, currently-unaddressed cost problem, independent
of the summarization debate below — worth doing regardless.

**The deeper question raised:** the card doesn't have to be pure
determinism-or-raw-evidence; there could be a summary in the card in place
of raw messages, without depending on the primary agent volunteering it via
`update_card`. Three mechanisms proposed:

a. **A separate background LLM call** that looks at about-to-retire
   evidence and writes the summary, mechanically inserted into the card.
   This is the same tradeoff class as two of the README's own explicitly
   *rejected* alternatives, just moved to a different call site: it's
   "model-maintained memory" (an extra call whose only job is bookkeeping)
   and it risks "summaries can drop exact implementation details" (the
   README's first listed reason for not doing this at all). Not free —
   extra latency, extra cost, and a sync problem (if it's async, is the raw
   evidence already gone by the time the summary lands?). Worth exploring,
   but it's a bigger philosophical reversal than it looks like at a glance.

b. **Piggyback a synthesis field onto the turn that already consumes the
   tool output** — no separate call, folded into the primary agent's next
   response. Structurally the most promising: stays inside "no extra model
   calls," and can reuse the `tryForceUpdateCardToolCall` infrastructure
   that already exists and already works *at the form level* — just
   retarget the trigger from "10 turns of inactivity" (proven too generic —
   3-for-3 empty `sources` even when forced) to "you just read something
   costly, before you do anything else." A specific, freshly-relevant ask
   is more likely to get a real answer than a periodic nag that's easy to
   satisfy with `findings: []`.

c. **A small classifier/summarizer model.** User's own read, which matches
   mine: limited capacity for large/complex content, and it's the exact
   "summaries can drop exact implementation details" risk the README
   already named as a reason to avoid this path. Lowest priority.

**Done:** hand-ported and extended the split. `formatContextCard` now emits
only the stable header (goal, taskId, latestRequest, project, repo, plan,
capabilities). New `formatCardStatus` covers everything volatile (execution
changes/failures, pending, findings, filesRead, resumed) and renders as a
separate `<context-card-status>` block, sent as a trailing message after
the projected conversation instead of folded into the leading card — same
mechanism as `d18c2fd`, extended to cover findings/filesRead/pending which
didn't exist when that commit was written. New `STATUS_MESSAGE_TYPE`
constant, new `statusChars` audit field. All tests updated and passing
(94/94), tsc/eslint/prettier/build clean.

**Done: automatic disuse retirement (step 1 of the agreed strategy).** Added
`consumedByDisuse` to `src/core/projection.ts`, the third member of the
`consumedReads`/`consumedByFinding` family: a read retires once nothing
later — no later assistant text, no later tool call's path or arguments —
ever references it again, with the same one-successful-round grace
requirement as its siblings. Not a timer: there's no fixed N, it's
recomputed fresh against the full transcript every request, so a read
retired at one point comes back into scope the moment something later
genuinely references it again (proven with a dedicated test: same read,
same grace point, differs only in whether a later round exists). New
`disused` counter on `RetirementCounts`, wired into both the per-turn
candidate filter and the global `activeRounds` computation, with its own
fault-injection check (disabled the wiring, confirmed multiple tests failed
including a pre-existing checkpoint one, restored it).

Hit a real, subtle interaction while building it, worth remembering: local
recomputation inside `projectTurn` is blind to anything outside whatever
slice it's given, so a read in a checkpoint's *prefix* whose only later
reference lives in the checkpoint's *suffix* looked "never referenced
again" to the local computation even though the global one knew better.
This is a pre-existing architectural property (the same blindness already
affected `consumedReads`/`consumedByFinding`, just usually hidden because
mutation/citation triggers are rarer than plain disuse), not something
introduced by this change — but disuse is far more sensitive to it, since
it requires *positive* evidence of continued use rather than a specific
trigger event. Fixed the immediately-visible test fallout (some fixtures
needed a legitimate later reference to isolate what they were actually
testing; one test's original assertion turned out to depend on the
blindness accidentally working in this project's favor, and got corrected
instead of preserved). Did not do a deeper structural fix (threading global
active-round truth into every local recomputation) - that's a larger,
separate piece of work if it turns out to matter in practice, not something
to take on inside this change.

**Done: step 2 (tighten the forcing trigger + validate substance).** Two
changes to `src/pi/index.ts`:
- A read over `COSTLY_READ_CHARS` (4000 chars) now pushes
  `cardActivitySinceUpdate` straight past the nudge/force threshold instead
  of waiting for ~10 generic activity units to accumulate — reuses the
  existing nudge (`turn_end`) and force (`before_provider_request`)
  machinery unchanged, just retargets when it fires. Guarded against
  `event.result` being `undefined` (a real crash the first test run
  caught — `messageText` assumes a defined object).
- `update_card`'s `execute()` now checks whether the response has real
  substance (a non-empty `pending` item, or a finding with non-empty
  `detail`) whenever it's answering a *forced* call (tracked via a new
  `awaitingForcedSubstance` flag set right when `tryForceUpdateCardToolCall`
  actually forces). A thin forced response no longer resets
  `cardActivitySinceUpdate`/`cardNudgeStreak`/`forceNudgeStreak` — forcing
  compels the call, not the content, so only a real answer earns the
  reset. Voluntary (non-forced) calls are untouched — still always reset,
  since a modest voluntary update is still a genuine engagement.

5 new tests in `tests/pi-adapter.test.ts`, each fault-injection-checked
(disabled the relevant branch, confirmed the test failed, restored it).
102/102 tests passing, tsc/eslint/prettier/build all clean.

**Done: the deeper local/global recomputation fix.** Sent to a background
agent (isolated worktree, not touching `src/pi/`) with the full root-cause
writeup from this file as its brief. It correctly diagnosed the same root
cause independently (`projectTurn`'s `current === true` branch ignores its
own `activeRounds` parameter and recomputes everything blind to whatever's
outside its slice), and landed the minimal fix: local exclusion is now
overridden by membership in the passed-down `activeRounds` -
`activeRounds.has(round.index) || (...local checks...)`. Since
`activeRounds` is always a subset of "not excluded by any global
mechanism," this can only add back a round the global pass already vouched
for, never suppress a local exclusion the global pass agrees with - so
every existing retirement behavior where local and global already agree
(the common case) is untouched.

Did not merge the agent's diff blindly. Reviewed it line by line, then
independently re-ran its fault-injection check myself in its worktree
(disabled the override, confirmed exactly its 3 new tests broke, none of
the 14 pre-existing ones did, restored it) before touching my own working
tree at all. Hand-applied just the two real changes (the `projectTurn`
override, 3 new tests) on top of my current files rather than taking its
replicated copies of everything else, since its snapshot predated my step-2
work on `src/pi/index.ts`. Ran the same fault-injection check a third time,
independently, directly on my real tree, before accepting it. Cleaned up
the worktree and its branch afterward. 105/105 tests passing,
tsc/eslint/prettier/build all clean, working tree has only the seven
intended files changed.

All three items from the agreed strategy are now done: automatic disuse
retirement, tightened/validated forcing, and the local/global consistency
fix underneath both.

**Proposed synthesis (not yet agreed, still open):** tighten (b)'s trigger to fire
immediately after a large/costly read rather than on a generic activity
counter, and — this is the part that ties everything today together —
*validate substance, not just form*: if a forced `update_card` still comes
back with empty `findings`/`sources`, don't reset the nudge streak as if it
succeeded; either re-force or fall through to the automatic, non-cooperative
signal (main's `consumedReads`-style mechanism, extended per the
reference-overlap idea above) as the real backstop. That reconciles both
branches' philosophies instead of picking one: try agent self-report,
tightly triggered and validated; if it doesn't deliver, the automatic
mechanism doesn't care whether the agent cooperated.
