# Working notes — 2026-09-16: the Haiku caching investigation

Continues the "consistent 50-60% token savings" campaign from
`docs/plans/repeat-detection-and-eval-harness-followups.md`. That plan's
first four steps (bash/grep near-duplicate detection, evidence-ledger
reconciliation, `zeroHotEvidence` resolution, SWE-bench grading) landed and
pushed to `origin/main` as commits `38a3cdd`, `4f8a773`, `b8f8501`,
`b39b8f8`. This note picks up mid-step-5, the multi-model repeat campaign,
where a major, previously-undocumented finding derailed the campaign into
its own investigation.

## What the campaign found before the derailment

**mycoder, ten-turn-mixed, n=3**: clean and tight — 3/3 correct both
variants, zero assertion failures, range **-24.7% to -17.2%** (median
-19.6%) on provider-input tokens. Real, consistent, but well below the old
(already-flagged-stale) -60% headline number.

**mycoder, SWE-bench sympy-18211, n=3 rerun** (after fixing stale
`resume: true` expectations — see below): high variance persists,
-20%..+21.6% across two n=3 batches, driven by one repeat where the model
made 54 genuinely-distinct verification calls (traced with `npm run
doctor`, confirmed not a near-duplicate pattern my bash/grep fix should
have caught). Still bounded below baseline's own historical worst case
(3.87M tokens, from the prior session's investigation).

**A real, unrelated bug surfaced and fixed along the way**: both
`evaluation/benchmarks/swebench-verified-sympy-*.json` configs, plus
`pi-plan-phase-experiment.json` and `pi-ten-turn-plan-framing.json`, had
stale `resume: true` expectations on non-first turns — the same
already-diagnosed-elsewhere bug class as `pi-ten-turn-mixed.json`'s earlier
fix (`resume` checks for a `"load"` task-state-audit op, which structurally
never fires under `sessionMode: "continue"`, confirmed by reading
`continuityAssertions` in `run.mjs` directly). Fixed and committed
(`b39b8f8`).

## The big one: Haiku 4.5 SWE-bench, tied tokens, 5-19x cost

`anthropic/claude-haiku-4-5` on sympy-18211, n=3: card's raw provider-input
tokens came out roughly **tied** with baseline (median -0.3%, range -54.4%
to +482%), but card's **real dollar cost was 5-19x higher**
($2.6-2.7/run vs $0.14-0.53/run). Traced with a narrow DuckDB query against
the raw session log: card's cache-read tokens were ~0 across all three
repeats (0, 0, 36K) against baseline's substantial cache-read (1.9M, 315K,
3.2M). Checked whether this is universal by comparing mycoder's own card
runs in the same rerun — it isn't: mycoder's card gets real cache-read hits
(1.7M, 135K, 348K). This is specific to genuine Anthropic prompt caching
(strict byte-exact prefix matching, confirmed in
`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:954-975`),
not universal to the extension's design.

**Original hypothesis**: `projectContext` (`src/core/projection.ts`)
recomputes retirement on every single provider request, not once per turn —
confirmed via the same DuckDB query, `retiredMessages` climbed almost every
request within one turn (0→2→4→…→242 across ~132 requests). Since
retirement removes messages from the middle of the transcript, and
Anthropic's cache requires the sequence up to a breakpoint to be
byte-identical to a prior request, this should defeat the cache on nearly
every call.

## Fix #1: pin retirement decisions to turn boundaries — confirmed correct, did not help

Built and shipped (then reverted, see below): a caching layer in the
`context` handler (`src/pi/index.ts`) that computes the full
`projectContext` result once at the start of a turn (using the existing
`currentTurn` counter, confirmed via code trace to stay constant across
every `context` call within a turn and increment exactly once between
turns) and, for subsequent calls in the same turn, reuses that pinned
result plus appends the new raw tail — instead of recomputing retirement
fresh every call. `card`/`lastStatus`/the audit entry still used the fresh
`projection` unchanged, so nothing about what the extension _reports_
(including `hotEvidence`/`zeroHotEvidence` assertions) was affected — only
what actually got sent to the provider.

Three new integration tests (`tests/pi-adapter.test.ts`, using the existing
`harness()`/`project()` helpers, confirmed via grep that no existing test
called `project()` twice within a simulated turn expecting full mid-turn
recomputation) proved the invariant: a second request within a turn keeps
everything the first request sent, even where fresh retirement would have
collapsed it; the deferred collapse still applies once the turn ends; a
`turnEnd` between two requests resets the pin. Full suite green
(165/165), `tsc`/`eslint`/`prettier`/build all clean.

**Reran the exact Haiku SWE-bench fixture. Cache-read stayed ~0 (0, 38K, 0) — no meaningful change.**

## Diagnosing why: real request-level instrumentation, not more guessing

Rather than keep theorizing, added temporary instrumentation directly in
the installed SDK (`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`,
gitignored, reverted after) to dump every real request's `params` (the
exact payload sent to Anthropic) to a local NDJSON file, then ran a
minimal, cheap, card-only diagnostic (`--variant card`, no baseline, no
repeats — cheapest run that still reproduces the pattern).

**Verified directly, byte-for-byte, across 48 real requests**: with the
turn-pinning fix in place, the message array genuinely is prefix-stable
within a turn (every within-turn consecutive pair matched exactly, modulo
the deliberately-volatile trailing `statusMessage` and the moving
`cache_control` marker, both expected). `system` and `tools` were also
stable. Only the two genuine turn boundaries showed a (correct, expected)
shrink. **The fix works exactly as designed at the request-payload level.**

Despite that, real per-message usage data from the raw session log showed
`cacheWrite` climbing every single request (4325→4453→4654→…) while
`cacheRead` stayed **exactly 0** the entire run, and `input` (fresh,
uncached tokens) dropped to near-nothing after the first few calls. That's
a specific, real signature: the cache is being _written_ successfully every
time but never _found_ on the next lookup, despite content being
demonstrably stable. Ruled out a client-side reporting bug too — the code
that parses `cache_read_input_tokens` from the Anthropic response and
assigns it to `usage.cacheRead` is straightforward and correct
(`anthropic-messages.js:381-382`, `:537-541`).

## Hypotheses checked and ruled out

1. **Missing OAuth `x-session-affinity` header** — these Haiku calls
   authenticate via OAuth (Claude subscription; confirmed by the OAuth-only
   system message `"You are Claude Code, Anthropic's official CLI for
Claude."` appearing in the captured payload). Code-confirmed
   (`anthropic-messages.js:661-677` vs `:678-684`): the OAuth client branch
   never sets `x-session-affinity`, unlike the API-key branch. **Ruled
   out** as a _sufficient_ explanation: baseline uses the identical
   auth/model and gets real cache hits, so a missing header on the shared
   client construction path can't be what differentiates card from
   baseline.
2. **Missing caching-related beta flag** — checked; prompt caching is GA,
   no beta header exists anywhere in this SDK version for it. Not the
   cause.
3. **Cache retention resolving to "none"** — checked `resolveCacheRetention`/
   `getCacheControl`; defaults to `"short"` (standard 5-minute ephemeral),
   and `cache_control: {type: "ephemeral"}` was directly observed present
   in captured requests. Not the cause.
4. **Two consecutive `role: "user"` messages** (custom→user conversion
   happens in `@earendil-works/pi-coding-agent`'s `convertToLlm`, meaning
   `cardMessage` immediately followed by the real turn-starting user
   message produces two adjacent user-role objects — a shape baseline
   never has). Built and tested a second fix: `mergeCardIntoFirst` folded
   the card's text into the first wire-history message as an extra content
   block instead of sending it as its own message (only 1 of 16
   `messages[0]`-touching tests needed a structural update; the other 15
   were content-substring checks that kept passing). Full suite green
   (165/165). **Reran the same minimal Haiku diagnostic. Cache-read stayed
   at 0.** Ruled out.

## Current status

**Both caching fixes reverted** — cleanly, since neither was ever
committed (`git checkout -- src/pi/index.ts tests/pi-adapter.test.ts`
restored the exact state after commit `b39b8f8`). Confirmed: working tree
clean, 162/162 tests pass, `tsc` clean. The turn-pinning fix was correct
and independently defensible (confers no proven benefit right now, but is
harmless in isolation and would be the right foundation if the underlying
cache-lookup problem is ever resolved) — reverted anyway per explicit
instruction, to avoid carrying unproven complexity.

**Genuinely unresolved**: why Anthropic's cache lookup misses for card's
Haiku requests specifically, despite a demonstrably stable, correctly
cache_control-marked, non-consecutive-user-role payload, while the
identical model/auth under baseline's simpler (no injected messages,
natural role alternation) request shape gets substantial cache hits. Every
theory checkable from this client's code has been checked and ruled out.
What's left is either something in the _exact_ token-level serialization
that differs in a way not visible at the message-object level (not yet
found), or an account/platform-side quirk not diagnosable without
Anthropic-side visibility.

**Practical implication for the "consistent 50-60% savings" goal**: on
Haiku (and plausibly any Claude model authenticated the same way), card's
real dollar-cost advantage cannot currently be assumed even when raw token
counts look favorable or neutral — this needs to be checked explicitly,
per-provider, going forward, not inferred from token counts alone. mycoder
(and presumably any router without strict Anthropic-style prefix caching)
remains unaffected by this specific problem.

## What's next, if anyone picks this back up

- Don't re-attempt either of the two ruled-out fixes without new evidence.
- If pursued further, the highest-value next step is probably getting
  Anthropic-side account/support visibility into why cache lookups aren't
  matching for these specific requests, rather than more client-side
  guessing — every angle checkable from this codebase has been checked.
- The original step-5 campaign (mycoder + Haiku, both fixtures, n≥3) is
  still incomplete: the Haiku `pi-ten-turn-mixed.json` leg was never run
  (this investigation superseded it). If resumed, budget for it
  separately — it would likely reproduce the same cost/token disconnect on
  Haiku, now a known, documented risk rather than a surprise.
