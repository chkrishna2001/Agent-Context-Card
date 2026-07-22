# Automated multi-session evaluation

The repository includes a reproducible Pi A/B runner for correctness, efficiency,
and cross-session continuity. It runs the same task sequence in isolated
workspaces with no extension and with agent-context-card, then writes machine
readable JSON, a Markdown summary, and raw traces.

Run the checked-in smoke evaluation with:

    bun run eval:pi

Results are written below `.agent-context-card/e/`, which is intentionally
gitignored because traces can contain prompts, model responses, and source
content. The checked-in configuration is
`evaluation/configs/pi-cross-session-smoke.json`.

## Protocol

Each variant receives its own copied fixture and Pi session directory. The
current sequence uses four fresh Pi sessions:

1. inspect the fixture and produce a plan for `ACCEVAL-101`;
2. implement the same task using the persisted plan;
3. validate and repair the same task;
4. perform an unrelated read-only task, `ACCEVAL-202`.

The fixture contains a real failing `node:test` check. Correctness is determined
by `node --test counter.check.mjs`, not by judging the assistant response. File
hashes also establish the exact added, changed, and deleted paths for each
variant.

The card variant additionally asserts that:

- the exact task ID is projected;
- the plan is captured automatically and promoted as revision 1;
- implementation and validation load the prior snapshot;
- exact file-read evidence does not cross session boundaries;
- the unrelated task does not resume or inherit the preceding plan.

A failed process, timeout, malformed JSON trace, failed validation, or failed
continuity assertion fails the run.

## Metrics

The JSON report retains per-turn and aggregate measurements for:

- provider requests and input, output, reasoning, cache-read, cache-write, and
  total tokens;
- reported provider cost and per-request maxima;
- tool calls, tool errors, exact duplicate signatures, and tool names;
- duration, exit status, timeouts, retries, compactions, and stop reasons;
- assistant and tool-result characters;
- session file bytes and entry counts;
- workspace hashes and added, changed, and deleted files;
- validation commands and file assertions;
- projection count, projected-token estimate, card size, original/projected
  message counts, retired messages, and live evidence;
- snapshot load/save outcomes, plan revisions, resumed execution facts, and
  repository-change detection.

Provider input in the report is `input + cacheRead + cacheWrite`, matching the
amount sent or materialized for the request. Fields remain separate so providers
with different cache accounting can still be compared.

## Finalized live result

On 2026-07-21, `llama-cloud/gemma4:31b` with thinking disabled produced this
single-run smoke result:

| Metric                | Baseline | Context card | Change |
| --------------------- | -------: | -----------: | -----: |
| Correctness           |     pass |         pass |  equal |
| Provider requests     |       16 |           13 | -18.8% |
| Provider input tokens |   24,457 |       21,717 | -11.2% |
| Output tokens         |      615 |          491 | -20.2% |
| Tool calls            |       12 |            9 | -25.0% |
| Tool errors           |        0 |            0 |  equal |
| Exact duplicate calls |        0 |            0 |  equal |
| Duration              |  71.14 s |      71.86 s |  +1.0% |

Both variants changed only `counter.mjs` and passed the fixture test. The
provider reported zero cost and zero cache tokens, so those fields were captured
but cannot support a comparison in this run.

Per-turn provider input was:

| Turn      | Baseline | Context card | Change |
| --------- | -------: | -----------: | -----: |
| Plan      |    6,093 |        6,414 |  +5.3% |
| Implement |   11,171 |        7,278 | -34.8% |
| Validate  |    2,916 |        3,553 | +21.8% |
| Unrelated |    4,277 |        4,472 |  +4.6% |

The point of this fixture is not that every short turn becomes cheaper. It tests
whether the implementation session can use a prior plan without replaying hot
evidence, while preserving correctness and isolating unrelated work.

The first attempted run exposed a deterministic planning-intent bug: the phrase
“follow the previously approved plan” was classified as a new planning request.
The detector was narrowed to explicit plan-creation and revision language, and a
regression test now covers that case.

## First SWE-bench Verified pilot

The first pinned real-repository pilot used sympy__sympy-18211, rated
15 minutes to 1 hour in SWE-bench Verified. Both variants received the same
issue statement across fresh planning, implementation, and review sessions.
The model was llama-cloud/gemma4:31b, thinking disabled.

| Metric                |   Baseline | Context card |           Change |
| --------------------- | ---------: | -----------: | ---------------: |
| Official resolution   | unresolved |     resolved | card only passed |
| Provider input tokens |  1,271,160 |      267,542 |           -79.0% |
| Provider requests     |         56 |           21 |           -62.5% |
| Output tokens         |      4,512 |        3,322 |           -26.4% |
| Tool calls            |         53 |           18 |           -66.0% |
| Tool errors           |          8 |            0 |            -100% |
| Exact duplicate calls |          4 |            0 |            -100% |
| Inference duration    |   439.69 s |     287.95 s |           -34.5% |

The baseline produced helper scripts but no production-code patch and failed the
official FAIL_TO_PASS test. The card changed
sympy/core/relational.py; the official evaluator applied the submitted patch,
passed test_issue_18188, passed all 54 PASS_TO_PASS tests, and marked the
instance resolved.

The provider reported zero monetary cost and zero cache tokens, so cost cannot
be compared directly for this model. Provider input is the available cost proxy.
This is one task and must not be presented as a pass-rate estimate. It does show
that the larger savings expected on a real multi-session repository task can
coincide with preserved—and in this sample improved—correctness.

The pilot also hardened the benchmark infrastructure:

- each turn is checkpointed before the next session;
- Windows timeouts terminate the complete descendant process tree;
- pinned Git mirrors avoid repeated full-history downloads;
- private .agent-context-card state is excluded from model submissions;
- official patches are transported to Linux containers with LF line endings;
- missing official reports fail grading rather than appearing unresolved;
- exact resolved, FAIL_TO_PASS, and PASS_TO_PASS counts are retained.

## Extending the evaluation

The runner supports copied fixtures and pinned Git workspaces. A configuration
can define model, thinking level, timeout, variants, ordered prompts, validation
commands, file assertions, and continuity expectations. The next evidence gate
should use repeated runs, multiple model families, and pinned SWE-bench or
SWE-Bench-CL tasks. This smoke fixture is automation proof, not a production or
general benchmark claim.
