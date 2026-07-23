# Automated multi-session evaluation

The repository includes a reproducible Pi A/B runner for correctness, efficiency,
and cross-session continuity. It runs the same task sequence in isolated
workspaces with no extension and with agent-context-card, then writes machine
readable JSON, a Markdown summary, and raw traces.

Run the checked-in smoke evaluation with:

    bun run eval:pi

Results are written below `.agent-context-card/e/`, which is intentionally
gitignored because traces can contain prompts, model responses, and source
content. Sanitized, claimable headline metrics and explicitly excluded
diagnostics are retained in
`evaluation/results/evidence-ledger.json`; tests recompute every published
percentage from its raw counts. The checked-in configuration is
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
- tool calls, tool errors, raw exact repeated signatures, state-aware repeated
  signatures, and tool names;
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

## Provider-setting activation audit

Provider-facing configuration now has an explicit evidence grade. A Pi setting or
session event proves requested configuration, not treatment activation. Before a
gate can claim a reasoning effort or similar provider treatment, capture the
provider-log boundary, run the gate, select only matching post-boundary requests,
reconcile their count with the report's provider-request total, and assert the
literal request field on every request. Retain sanitized counts, not prompts or
complete request payloads.

The 2026-07-23 audit used the AIInferenceRouter SQLite inference log through a
read-only DuckDB attachment:

| Gate or route                                  | Config/session evidence                                    | Literal request evidence                                                   | Evidence grade               |
| ---------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| Nano controlled low n=1                        | 20/20 sessions recorded `low`                              | 97/97 requests carried `reasoning_effort: low`; report also counted 97     | wire-verified                |
| Nano controlled low n=3                        | all six runs requested `low`                               | 264/264 requests carried `reasoning_effort: low`; reports also counted 264 | wire-verified                |
| Nano scope-note n=3                            | 18/18 treated card turns activated post-planning framing   | 252/252 requests carried                                                   |
| easoning_effort: low; reports also counted 252 | wire-and-projection-verified                               |
| Older Nano runs                                | Pi requested `off`                                         | 622/622 audited requests had the field absent/null                         | wire-verified uncontrolled   |
| `mycoder` alias                                | Pi model declared `reasoning: false`                       | 107/107 audited requests had the field absent/null                         | wire-verified not applicable |
| Direct Gemma gates                             | Pi requested `off`; reports recorded zero reasoning tokens | Historical outbound bodies and model definition unavailable                | session-and-usage only       |

This audit identifies one standing failure class shared with the phase-aware
experiment: configured treatment can differ from activated treatment. Future
provider-sensitive gates fail preflight unless activation is observed at the
wire or an equally direct provider boundary. The controlled Nano n=3 replication used the request-count reconciliation
above and found zero absent or mismatched effort values.

## Finalized live result

On 2026-07-21, `llama-cloud/gemma4:31b` with Pi requesting thinking off
produced this single-run smoke result:

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
The model was llama-cloud/gemma4:31b with Pi requesting thinking off. Provider usage recorded zero reasoning tokens, but historical outbound request bodies are unavailable, so wire-level activation is unverified.

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

## Interrupted second SWE-bench attempt

On 2026-07-21, an attempted run of `sympy__sympy-21930` with the same model
did not complete and is retained only as a diagnostic record. It must not be
used as an A/B result in the README, articles, or aggregate claims.

| Metric                | Baseline | Context card |
| --------------------- | -------: | -----------: |
| Sessions recorded     |      1/3 |          3/3 |
| Provider requests     |        7 |           22 |
| Provider input tokens |   87,899 |      152,529 |
| Output tokens         |      454 |          422 |
| Tool calls            |        7 |           10 |
| Tool errors           |        1 |            0 |
| Provider errors       |        0 |           12 |
| Duplicate calls       |        0 |            4 |
| Inference duration    | 301.27 s |     205.86 s |

The baseline timed out during its planning session after creating only a
reproduction helper, with no production-code change. The card planning session
then exhausted the Ollama Cloud session allowance: four HTTP 429 responses ended
that session without a final plan, and the implementation and review sessions
each received four more HTTP 429 responses. Consequently, the card captured no
plan and produced an empty patch. The apparent differences above combine a
timeout with quota exhaustion and are not comparable performance measurements.

This attempt motivated an evaluation-harness rule: an assistant message with a
provider `error` stop reason is counted separately from tool errors, fails the
turn, and prevents later sessions in that variant from running. Raw traces and
full reports remain under the ignored `.agent-context-card/e/` directory.

## Second SWE-bench Verified pilot

A completed rerun of `sympy__sympy-21930` on 2026-07-22 used the same
`llama-cloud/gemma4:31b` model with Pi requesting thinking off across fresh planning,
implementation, and review sessions. Both variants completed all sessions
without provider errors, and every card continuity assertion passed.

| Metric                 |   Baseline | Context card |      Change |
| ---------------------- | ---------: | -----------: | ----------: |
| Official resolution    | unresolved |   unresolved |       equal |
| FAIL_TO_PASS pass/fail |        0/6 |          5/1 | card closer |
| PASS_TO_PASS pass/fail |       45/0 |         45/0 |       equal |
| Provider input tokens  |  1,094,429 |      286,995 |      -73.8% |
| Provider requests      |         37 |           20 |      -45.9% |
| Output tokens          |      4,975 |        2,195 |      -55.9% |
| Tool calls             |         34 |           17 |      -50.0% |
| Tool errors            |          4 |            0 |       -100% |
| Duplicate calls        |         10 |            2 |      -80.0% |
| Inference duration     |   555.43 s |     141.35 s |      -74.6% |

The baseline added only reproduction helpers and made no production-code
change. The card patched `sympy/physics/secondquant.py`, and the official
evaluator applied both submissions successfully. The card passed five of the six
FAIL_TO_PASS tests and all 45 PASS_TO_PASS tests, but remained unresolved because
`test_Tensors` still failed: the implementation grouped boson and fermion
creation operators but missed the required `AntiSymmetricTensor` LaTeX grouping.

This is valid negative evidence. It shows a large efficiency improvement and a
substantial movement toward the correct patch, but it is not a resolved
benchmark result and must not be presented as a pass. Together with the first
pilot, the two official outcomes are one card resolution and one shared
non-resolution; two tasks are far too few for a pass-rate claim.

## Ten-session mixed gate

On 2026-07-22, the checked-in `pi-ten-turn-mixed.json` gate completed with the
`ai-inference-router/mycoder` Pi routing configuration. It exercised two
plan/implement/validate workflows, documentation, review, and two unrelated-task
resets in fresh sessions.

| Metric             | Baseline | Context card | Change |
| ------------------ | -------: | -----------: | -----: |
| Correctness        |     pass |         pass |  equal |
| Provider requests  |       48 |           34 | -29.2% |
| Tool calls         |       38 |           25 | -34.2% |
| Tool errors        |        4 |            0 |  -100% |
| Duplicate calls    |        3 |            0 |  -100% |
| Inference duration | 183.48 s |     151.30 s | -17.5% |

Both variants passed all six final tests and changed only `counter.mjs` and
`README.md`. Their production files were byte-identical; documentation wording
differed but described the same behavior. All card continuity assertions passed:
plans resumed at revision 1, no file-read evidence crossed sessions, and both
unrelated tasks inherited no prior plan.

The router reported zero usage and cost fields, so token, output, cache, and cost
comparisons are unavailable and stored as `null` in the evidence ledger. The
configured route may select providers internally; the report identifies only
`ai-inference-router/mycoder`, so it must not be described as evidence for a
specific underlying model family.

## GPT-5 Nano ten-session gate

The same gate completed on 2026-07-22 with
`ai-inference-router/openai/gpt-5-nano`. Pi requested thinking off, but the router did not yet expose reasoning-effort control, so this cohort had uncontrolled effort.

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

Both variants passed all six final tests, changed only `counter.mjs` and
`README.md`, and all card continuity assertions passed. Their implementation
styles differed: the baseline added unrequested non-finite-number handling,
while the card made the smaller boundary-only change. This is a behavioral
observation, not proof that one implementation generalizes better.

The result is mixed beyond the headline savings. The card reduced provider
input, total tokens, requests, tools, errors, and duration, but output and
reasoning increased. The original raw-signature counter rose from one to five.
Trace-level classification found that four card repeats were fresh file reads or
test reruns after successful edits; the state-aware count was zero for baseline
and one for the card, caused by a repeated malformed-path read. One additional
card error was the expected failing test that led to a corrective edit. Pi requested thinking off, but no `reasoning_effort` value was sent; the
provider still reported reasoning tokens. The ledger now labels this run as effort
uncontrolled rather than treating the requested setting as applied.

Raw repeated signatures remain in historical reports for reproducibility. The
state-aware metric resets a file-read signature only after a successful mutation
of that path, and resets command signatures after a successful mutation. It does
not treat post-edit rereads or post-fix validation as same-state repetition.

## GPT-5 Nano controlled low-effort rerun

On 2026-07-23, after the router implemented `reasoning_effort`, Pi's Nano model
was configured with `reasoning: true`, model-level
`compat.supportsReasoningEffort: true`, and this capability map:

- Pi `off` sends provider value `none`;
- Pi `minimal` sends `minimal`;
- Pi `low` sends `low`;
- `medium`, `high`, `xhigh`, and `max` are unsupported.

The runner gained an explicit `--thinking` override and the reproducible command
`bun run eval:pi:nano-low`. A complete ten-session baseline/card pair ran at
`low`; all 20 session events recorded `thinkingLevel: low`.

| Metric                  | Baseline | Context card | Change |
| ----------------------- | -------: | -----------: | -----: |
| Correctness             |     pass |         pass |  equal |
| Provider input tokens   |  112,923 |       58,903 | -47.8% |
| Total tokens            |  120,634 |       66,726 | -44.7% |
| Provider requests       |       67 |           30 | -55.2% |
| Output tokens           |    7,711 |        7,823 |  +1.5% |
| Cache-read tokens       |   88,192 |       39,936 | -54.7% |
| Reasoning tokens        |    3,983 |        3,436 | -13.7% |
| Tool calls              |       57 |           20 | -64.9% |
| Tool errors             |        4 |            3 | -25.0% |
| Raw repeated signatures |        2 |            1 | -50.0% |
| Same-state repeats      |        1 |            0 |  -100% |
| Inference duration      | 310.43 s |     252.32 s | -18.7% |

Both variants passed all six production tests, the README assertion, and every
card continuity assertion. The baseline overwrote most of the fixture README and
added `package-lock.json`; the card preserved the README structure and added no
artifact. Both implementations introduced input-type behavior beyond the narrow
boundary requirement, so neither was a strictly minimal production patch.

This result resolves the configuration ambiguity: effort was explicitly mapped
and applied, and card reasoning tokens fell rather than rose. It remains one
pair, however, so it does not supersede the uncontrolled n=3 reliability result
or establish a controlled pass rate. The complete controlled replication below supersedes this as the reliability
gate.

### Controlled low-effort n=3 result

A fresh, complete n=3 repeated the ten-session baseline/card gate. The six
reports counted 264 provider requests. The pre-run router boundary was inference
log ID 829 and the post-run maximum was 1093; a read-only DuckDB query selected
exactly 264 matching Nano requests, and every request carried literal
`reasoning_effort: low`.

| Metric                |   Paired median change |   Observed range |
| --------------------- | ---------------------: | ---------------: |
| Correct runs          | baseline 3/3; card 0/3 |       card worse |
| Provider input tokens |                 -35.7% | -45.1% to -31.5% |
| Total tokens          |                 -30.7% | -40.9% to -29.6% |
| Provider requests     |                 -42.4% | -49.1% to -33.3% |
| Tool calls            |                 -52.0% | -60.4% to -41.5% |
| Tool errors           |                 -40.0% |  -80.0% to -9.1% |
| Output tokens         |                 +12.6% |  -4.2% to +36.5% |
| Reasoning tokens      |                  -3.0% | -27.8% to +25.7% |
| Cache-read tokens     |                 -49.4% | -51.8% to -39.9% |
| Raw repeats           |                 -50.0% |   -66.7% to 0.0% |
| Inference duration    |                  -5.7% |  -25.8% to -4.3% |

All three baselines passed. Every card run completed ten sessions and passed
the continuity and README assertions, but failed the final production tests:
increment remained broken in all three, and decrement remained broken in two.
The failure mechanism reproduced cleanly. During implementation, Nano received
the correct latest request alongside the exact pinned planning text containing
“Do not modify files.” It returned another plan, stated that it had performed no
edits, and waited for approval instead of implementing.

This is controlled stale-plan dominance, not missing context or an effort-
activation artifact. The efficiency reductions occurred in every pair, but
they are not a positive product result because correctness regressed in every
card run. The precise defect is verbatim carryover of a phase-scoped constraint;
this result does not show that durable plan steps are generally unsafe. The
earlier passing controlled n=1 remains valid as one observation but is not a
reliability estimate.

### Post-planning scope-note n=3

The smallest follow-up intervention preserved the exact plan body and inserted
one deterministic note before it: the plan was written during planning, the
current request was post-planning, and constraints scoped only to planning no
longer applied. This is not the retirement-based `phase-aware` policy. No plan
content was deleted, rewritten, or classified.

The treatment is exposed only through the experimental
`context-card-plan-framing=scope-note` flag and the reproducible
`bun run eval:pi:nano-low-framing` command. Normal behavior remains `off`.
Configured mode and activated state are recorded separately. Across the n=3,
all 18 intended plan-carrying card turns recorded `scope-note` plus
`post-planning`, and every treatment assertion passed.

| Metric                |   Paired median change |    Observed range |
| --------------------- | ---------------------: | ----------------: |
| Correct runs          | baseline 3/3; card 1/3 |        card worse |
| Provider input tokens |                 -27.5% |  -29.0% to -24.3% |
| Total tokens          |                 -20.9% |  -26.0% to -19.7% |
| Provider requests     |                 -39.6% |  -50.0% to -36.2% |
| Tool calls            |                 -48.8% |  -63.2% to -43.8% |
| Tool errors           |                   0.0% | -25.0% to +250.0% |
| Output tokens         |                 +45.7% |  +21.6% to +47.8% |
| Reasoning tokens      |                 +28.5% |  +26.6% to +51.0% |
| Cache-read tokens     |                 -37.7% |  -46.4% to -33.9% |
| Raw repeats           |                 -75.0% | -100.0% to +50.0% |
| Inference duration    |                  +1.7% |   -28.0% to +3.4% |

The six reports counted 252 provider requests. With router-log ID 1093 as the
pre-run boundary, a read-only DuckDB query found exactly 252 matching Nano
requests through ID 1364, all carrying literal `reasoning_effort: low`; 46
post-boundary requests for unrelated concurrent `mycoder` traffic were excluded.

The intervention improved observed card correctness from 0/3 to 1/3, but did not
close the gap. Repeat 2 left increment broken; repeat 3 left both increment and
decrement broken. Their traces explicitly re-adopted “do not modify” from the
verbatim plan body despite the scope note. Output and reasoning also rose in all
three pairs, and median duration was slightly worse. Do not promote the note as
a fix. Its failure supports a deeper design experiment that separates durable
plan steps from phase-scoped process constraints by construction.

A fixture audit found the same planning-phase no-edit language in all finalized
checked-in cross-session gates: the smoke fixture, the mixed fixture, the earlier
phase experiment, and both SymPy pilots. Their prior passes demonstrate that
some models/runs inferred the phase transition successfully; they do not prove
that the ambiguity was absent or that those model families are immune.

## GPT-5 Nano pooled three-pair result

Three complete comparable pairs are available across two executions: the
original pair above and the first two complete pairs from a fresh n=3 attempt.
The fresh execution's one-hour outer ceiling interrupted its third card run, so
that incomplete run is excluded; its complete third baseline is retained only as
an unpaired diagnostic. Two later card recovery attempts ended after repeated
provider `Connection error` responses and are also excluded.

| Metric                | Paired median change |    Observed range |
| --------------------- | -------------------: | ----------------: |
| Provider input tokens |               -23.9% |   -58.6% to +5.1% |
| Total tokens          |               -16.3% |   -50.4% to +9.0% |
| Provider requests     |               -29.1% |  -31.3% to -10.2% |
| Tool calls            |               -33.3% |  -38.2% to -12.5% |
| Tool errors           |               -50.0% | -100.0% to -25.0% |
| Cache-read tokens     |               -24.2% |   -63.9% to -5.3% |
| Output tokens         |               +17.1% |   +2.7% to +23.9% |
| Reasoning tokens      |               +24.7% |   +8.7% to +30.9% |
| Inference duration    |                -0.4% |  -12.4% to +14.1% |

All three baselines passed the complete protocol; two of three card runs passed.
In the failed card run, all continuity assertions and all six production tests
passed, but the documentation turn returned a new plan instead of editing
`README.md`, so the explicit file assertion failed. Its card contained the
correct latest request plus the full approved plan, including the plan marker
and implementation/validation headings. The response copied that plan structure.
This is evidence of possible stale-plan dominance for Nano, not missing task
context. It invalidates any claim that correctness has never been worse with the
card.

Provider input fell in two pairs and rose 5.1% in one. Requests and tool calls
fell in every pair, while output and provider-reported reasoning rose in every
pair. Duration was effectively flat at the median. Raw repeat counts had medians
of one for baseline and zero for card; same-state repeat medians were zero on
both sides. The exact pair values and all excluded diagnostics are in the
evidence ledger.

## GPT-5 Nano phase-aware plan experiment

A focused four-session policy experiment compared two card-enabled variants:

- `full-plan`, the unchanged default;
- `phase-aware`, an opt-in mode that retires the full plan body during a
  non-execution phase only after successful change and validation facts exist.

Both modes retained the exact plan in task storage. Every projection asserted its
configured mode, and the final gates required the focused increment tests and an
exact README sentence. A complete n=3 cohort produced:

| Metric                | Full-plan median | Phase-aware median | Paired candidate change |
| --------------------- | ---------------: | -----------------: | ----------------------: |
| Correct runs          |              3/3 |                2/3 |         candidate worse |
| Provider input tokens |           28,515 |             49,853 |                  +58.8% |
| Total tokens          |           42,191 |             64,899 |                  +49.1% |
| Provider requests     |               17 |                 23 |                  +20.8% |
| Tool calls            |               13 |                 19 |                  +30.0% |
| Output tokens         |           15,687 |             15,046 |                   -4.1% |
| Reasoning tokens      |           13,504 |             12,736 |                   -9.5% |
| Duration              |         169.64 s |           188.10 s |                  +18.0% |

The ranges were wide: paired provider-input change ran from -38.9% to +90.0%.
All full-plan documentation turns edited README successfully. One phase-aware
assignment failed during implementation: it made only two reads, recorded no
verified change or validation, and therefore never crossed the retirement
boundary. Its documentation turn still received the full plan and returned
another plan with zero tool calls. The final increment and README gates failed.

This is a negative intention-to-treat result for the candidate, but it does not
show that activated retirement caused the failure. The failure occurred before
the treatment could activate, and the original stale-plan failure did not recur
in any of the three full-plan controls. Do not promote phase-aware mode to the
default or claim it fixes Nano from this evidence.

Two earlier attempts are excluded. The first used `npm test`, accidentally
including intentionally failing decrement tests outside the focused task. After
that was corrected, a full-plan implementation session hit the five-minute
ceiling while phase-aware completed, making the execution asymmetric. A single
full-plan recovery and the completed candidate both passed, but that preliminary
pair was superseded by the complete n=3 cohort.

The experiment exposed a telemetry gap: configured mode did not reveal whether
retirement actually fired. Projection audits now record plan state as `none`,
`full`, or `retired`, and reports show both mode and state per turn. This telemetry
was added after the n=3 gate and must be used in any follow-up mechanism study.

## Extending the evaluation

Run the ten-session gate with `bun run eval:pi:ten-turn`, or the controlled Nano
low-effort form with `bun run eval:pi:nano-low`. The focused plan-policy
fixture is available as `bun run eval:pi:plan-phase`; its current phase-aware
variant is experimental and produced a negative n=3 result. Either command can
override its model through the runner CLI.

The runner supports copied fixtures and pinned Git workspaces. A configuration
can define model, thinking level, timeout, variants, ordered prompts, validation
commands, file assertions, and continuity expectations. `--repeats` now emits
medians, ranges, correctness counts, and paired changes; `--variant` and
`--repeat-start` can recover a missing repeat without rerunning completed work.
Each completed run is checkpointed as `run.json`. The next evidence gate
should use repeated runs, multiple model families, and pinned SWE-bench or
SWE-Bench-CL tasks. This smoke fixture is automation proof, not a production or
general benchmark claim.
