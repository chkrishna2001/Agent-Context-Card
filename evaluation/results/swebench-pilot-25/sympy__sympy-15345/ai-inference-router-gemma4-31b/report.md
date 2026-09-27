# SWE-bench Verified sympy__sympy-15345

Generated: 2026-09-17T02:40:23.869Z

| Variant | Correct | Requests | Provider input | Output | Cache read | Cache write | Cost | Tools | Tool errors | Provider errors | Raw repeats | Same-state repeats | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline-r1 | ungraded | 21 | 129232 | 2495 | 118912 | 0 | $0.000000 | 18 | 2 | 0 | 4 | 0 | 91.93s |
| baseline-r2 | ungraded | 21 | 86282 | 2127 | 80512 | 0 | $0.000000 | 18 | 1 | 0 | 1 | 0 | 50.58s |
| baseline-r3 | ungraded | 24 | 131752 | 2361 | 122336 | 0 | $0.000000 | 21 | 2 | 0 | 4 | 0 | 54.44s |
| card-r1 | ungraded | 163 | 2545843 | 13571 | 2230720 | 0 | $0.000000 | 162 | 13 | 0 | 77 | 73 | 707.89s |
| card-r2 | ungraded | 219 | 5452948 | 18765 | 4874688 | 0 | $0.000000 | 215 | 6 | 0 | 86 | 50 | 838.33s |
| card-r3 | ungraded | 191 | 2737467 | 18669 | 2210336 | 0 | $0.000000 | 189 | 13 | 0 | 54 | 49 | 991.35s |

## Per-turn metrics

### baseline-r1

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 7 | 18276 | 1123 | 6 | 1 | 0 | 60.55s | — | — | 0 | — | — | — | — | — |
| implement | 11 | 79256 | 1010 | 10 | 1 | 0 | 24.78s | — | — | 0 | — | — | — | — | — |
| review | 3 | 31700 | 362 | 2 | 0 | 0 | 6.60s | — | — | 0 | — | — | — | — | — |

### baseline-r2

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 10 | 29701 | 1110 | 9 | 1 | 0 | 25.91s | — | — | 0 | — | — | — | — | — |
| implement | 8 | 39003 | 731 | 7 | 0 | 0 | 18.00s | — | — | 0 | — | — | — | — | — |
| review | 3 | 17578 | 286 | 2 | 0 | 0 | 6.68s | — | — | 0 | — | — | — | — | — |

### baseline-r3

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 11 | 32413 | 1039 | 10 | 1 | 0 | 26.79s | — | — | 0 | — | — | — | — | — |
| implement | 10 | 70748 | 1007 | 9 | 1 | 0 | 20.39s | — | — | 0 | — | — | — | — | — |
| review | 3 | 28591 | 315 | 2 | 0 | 0 | 7.27s | — | — | 0 | — | — | — | — | — |

### card-r1

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 27 | 128268 | 2140 | 26 | 3 | 0 | 62.83s | 610 | 3434 | 1 | — | full | none | off | none |
| implement | 136 | 2417575 | 11431 | 136 | 10 | 0 | 645.06s | 1041 | 22776 | 4 | — | full | none | off | none |

### card-r2

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 41 | 381525 | 3724 | 39 | 1 | 0 | 118.00s | 610 | 8810 | 1 | — | full | none | off | none |
| implement | 159 | 4980855 | 12690 | 158 | 2 | 0 | 657.49s | 1041 | 21744 | 1 | — | full | none | off | none |
| review | 19 | 90568 | 2351 | 18 | 3 | 0 | 62.84s | 1035 | 3635 | 1 | — | full | none | off | none |

### card-r3

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 113 | 1978940 | 12095 | 111 | 4 | 0 | 548.79s | 610 | 19266 | 3 | — | full | none | off | none |
| implement | 78 | 758527 | 6574 | 78 | 9 | 0 | 442.56s | 1041 | 19394 | 3 | — | full | none | off | none |


## Repeated-run distributions

- baseline: 0/3 correct
- card: 0/3 correct

Medians are followed by the observed minimum-to-maximum range.

| Metric | baseline | card | Paired candidate change |
| --- | ---: | ---: | ---: |
| Provider input tokens | 129232 (86282 to 131752) | 2737467 (2545843 to 5452948) | 1977.7% (1870% to 6219.9%) |
| Total tokens | 131727 (88409 to 134113) | 2756136 (2559414 to 5471713) | 1955.1% (1843% to 6089.1%) |
| Output tokens | 2361 (2127 to 2495) | 18669 (13571 to 18765) | 690.7% (443.9% to 782.2%) |
| Reasoning tokens | 0 (0 to 0) | 0 (0 to 0) | n/a |
| Cache-read tokens | 118912 (80512 to 122336) | 2230720 (2210336 to 4874688) | 1775.9% (1706.8% to 5954.6%) |
| Provider requests | 21 (21 to 24) | 191 (163 to 219) | 695.8% (676.2% to 942.9%) |
| Tool calls | 18 (18 to 21) | 189 (162 to 215) | 800% (800% to 1094.4%) |
| Tool errors | 2 (1 to 2) | 13 (6 to 13) | 550% (500% to 550%) |
| Raw repeated signatures | 4 (1 to 4) | 77 (54 to 86) | 1825% (1250% to 8500%) |
| Same-state repeated signatures | 0 (0 to 0) | 50 (49 to 73) | n/a |
| Duration (ms) | 54444.6 (50584.2 to 91930.9) | 838325.3 (707887.9 to 991349.2) | 1557.3% (670% to 1720.8%) |


## Assertions

### baseline-r1


### baseline-r2


### baseline-r3


### card-r1

- PASS: turn 1 — task ID projected
- PASS: turn 1 — snapshot not resumed
- PASS: turn 2 — task ID projected
- FAIL: turn 2 — zero cross-session evidence leases
- FAIL: turn 2 — plan revision 1

### card-r2

- PASS: turn 1 — task ID projected
- PASS: turn 1 — snapshot not resumed
- PASS: turn 2 — task ID projected
- FAIL: turn 2 — zero cross-session evidence leases
- FAIL: turn 2 — plan revision 1
- PASS: turn 3 — task ID projected
- PASS: turn 3 — zero cross-session evidence leases
- FAIL: turn 3 — plan revision 1

### card-r3

- PASS: turn 1 — task ID projected
- PASS: turn 1 — snapshot not resumed
- PASS: turn 2 — task ID projected
- FAIL: turn 2 — zero cross-session evidence leases
- FAIL: turn 2 — plan revision 1

