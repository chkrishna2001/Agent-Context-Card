# Prompt-cache effect on card savings (2026-10-05)

Question: do the card's raw provider-input savings survive on providers that
discount cached prompt prefixes? Answer from existing paired reports: **no, not
today.** On every caching provider measured, the card lowers raw input but
raises uncached input, and on short multi-turn sessions it costs more than
baseline once cached tokens are priced below uncached ones.

Reproduce: `node scripts/evaluation/cache-effect.mjs <report.json>... [--cached 0.1]`
(effective = uncached + ratio × cacheRead + 1.25 × cacheWrite on anthropic/*).
Reports live in gitignored `.agent-context-card/e/<run>/report.json`.

## Measured (cached-token price ratio 0.1, as OpenAI GPT-5 and Anthropic reads)

| Gate (n)                                  | Model             | Hit base → card | Raw Δ median |       Effective Δ median |
| ----------------------------------------- | ----------------- | --------------- | -----------: | -----------------------: |
| ten-turn (3) `kimi-gate-n3`               | kimi-k2.7-code    | 93% → 75%       |       -28.1% |               **+45.5%** |
| ten-turn (3) `n3-gate-today-fixes`        | router gemma4:31b | 94% → 78%       |       -16.8% |               **+63.4%** |
| ten-turn (3) `mycoder-ten-turn-n3`        | router mycoder    | 94% → 79%       |       -19.6% |               **+50.7%** |
| ten-turn (3) `ten-turn-gpt-5-nano-low-n3` | gpt-5-nano        | 74% → 61%       |       -35.7% | -27.2% (one pair +19.8%) |
| SWE 18211 (3) `haiku-18211-n3-cachefix`   | claude-haiku-4-5  | 97% → 0%        |       -32.2% |                **+530%** |
| SWE 18211 (3) `mycoder-18211-n3-v3`       | router mycoder    | 89% → 77%       |       +21.6% |                    +117% |
| SWE 15345 (1) `kimi-swe-15345`            | kimi-k2.7-code    | 97% → 82%       |       -88.2% |                   -75.2% |
| SWE (1) `openrouter-qwen3-coder-v2`       | qwen3-coder       | 94% → 56%       |       -80.6% |                   -36.6% |

At ratio 0.25 the ten-turn medians are still worse for the card: kimi +4.8%,
gemma +17.6%, mycoder +10.5%. Card savings survive caching only in long
sessions where retirement removes a lot (kimi SWE, qwen SWE), and never on
Anthropic. Correctness differs between some pairs; this note is about cost only.

## Cause 1 (automatic prefix caches: OpenAI, kimi, router): per-turn header churn

The card message sits at position 0 and contains `LATEST REQUEST:` (plus
`repo: … @ HEAD` and plan revision), so it changes at every user turn and
invalidates the whole cached history behind it. Splitting card uncached input
by request position (first request of a user turn vs later):

| Gate                 | Baseline turn-first | Card turn-first | Share of card's extra uncached |
| -------------------- | ------------------: | --------------: | -----------------------------: |
| kimi ten-turn n=3    |               3,935 |          24,692 |                            63% |
| gemma ten-turn n=3   |               5,679 |          27,392 |                            79% |
| mycoder ten-turn n=3 |               5,536 |          26,852 |                            86% |

Within a turn the cache holds. Only the trailing status block and new messages
are uncached, and requests that change the retirement count add 1–13%. The
status block was already moved out of position 0 for this reason
(`src/core/format.ts` `formatCardStatus`); the header still churns.

## Cause 2 (Anthropic): the single breakpoint lands on the volatile status

This resolves the open question in `haiku-cache-defeat-2026-09-16.md`. Pi puts
one message-level `cache_control` on the last block of the last user message
(`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:954-975`).
With the card, that block is always the trailing status message. Anthropic
reads cache only at a prefix that ended at a previous breakpoint, and every
earlier breakpoint ended in a status block that is no longer at that position.
So every request writes the full prompt (1.25×) and none can ever read it.
Baseline's breakpoint is on its last real message, which the next request
extends, so it hits.

Evidence: in `haiku-18211-n3-cachefix/r2-1`, turn 3 requests 4–8 retire nothing
and have identical status length, a strict extension except for the trailing
status, yet `cacheRead=0` and `cacheWrite` equals the whole prompt each time.
The first three requests (no status, under Haiku's minimum cacheable size)
write nothing. Card requests that read any cache: 1 of 206 in
`haiku-18211-n3-cachefix`, 2 of 336 in `haiku-18211-n3`.
The two earlier fixes (turn-pinned retirement, merging the card into the first
message) did not touch the breakpoint position, which is why neither helped.

## Implications

- Do not claim token or cost savings on caching providers from raw provider
  input. Report hit rate and effective cost (this script) alongside it.
- Candidate fixes, each a behavior change needing an n=3 A/B gate with cache
  telemetry:
  1. Keep the position-0 header byte-stable for the task: move `LATEST REQUEST`
     and repo HEAD into the per-turn tail. Risk: `LATEST REQUEST` placement may
     matter for stale-plan dominance (see AGENTS.md), so gate correctness first.
  2. Make the status block stable within a turn (emit once at turn start,
     keep it in place) and pin retirement to turn boundaries (fix #1 from the
     Haiku note). On Anthropic this is required for any cache read at all.
  3. Expect one cache miss per turn from completed-turn retirement even after
     1 and 2; whether retirement savings beat that is the measurement to rerun.
