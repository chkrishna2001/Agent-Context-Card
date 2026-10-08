# Stubbed old turns: tried, failed (2026-10-06)

Idea: turns older than the recent window are kept as request + final reply
stubs instead of dropped, so history behind the window is append-only and
cacheable (see `prompt-cache-effect-2026-10-05.md`, "Where the turn-first miss
starts"). Prototyped behind `--context-card-old-turns`, then reverted.

Gate: `ollama-cloud/kimi-k2.7-code:cloud`, ten-turn mixed, n=3, fresh baseline
each time. The default (drop) card passed 6/6 on this model earlier the same day.

| Variant                      | Card correct | Failure                                               |
| ---------------------------- | -----------: | ----------------------------------------------------- |
| `stubs`                      |          1/3 | 0 tool calls in turns 6-10; replies claimed tests ran |
| `stubs-tools` (tool-summary) |          0/3 | 0 tool calls from turn 3 in 2 of 3 runs               |

`stubs-tools` prefixed each stub reply with a deterministic
`[Tools run this turn: ...]` line built from the turn's tool calls. A replay
confirmed the line was projected. It did not help.

Effective-cost figures from these runs are not usable: runs that skip the work
are cheap. Failing runs reported the model writing "I ran `npm run test:...`,
3 pass" with no tool call.

Likely cause (inferred, not isolated): a history of finished, tool-free-looking
turns teaches the model to answer without acting, or the summary line reads as
"already done". Do not retry without a design that keeps live evidence, not
more finished-turn history.

Remaining cost lever (untested): defer retirement of the previous turn by one
user-turn boundary, opt-in only (it is a cost threshold; see AGENTS.md on
fixed budgets).
