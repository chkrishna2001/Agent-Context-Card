# SWE-bench Verified django__django-13658

Generated: 2026-09-17T01:50:28.462Z

| Variant | Correct | Requests | Provider input | Output | Cache read | Cache write | Cost | Tools | Tool errors | Provider errors | Raw repeats | Same-state repeats | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline-r1 | ungraded | 24 | 443100 | 2867 | 416736 | 0 | $0.000000 | 21 | 4 | 0 | 3 | 1 | 104.94s |
| baseline-r2 | ungraded | 24 | 497730 | 2209 | 455296 | 0 | $0.000000 | 21 | 5 | 0 | 2 | 1 | 86.87s |
| baseline-r3 | ungraded | 13 | 142665 | 2956 | 128128 | 0 | $0.000000 | 10 | 0 | 0 | 0 | 0 | 54.09s |
| card-r1 | ungraded | 32 | 338569 | 10554 | 246976 | 0 | $0.000000 | 27 | 4 | 0 | 1 | 1 | 390.24s |
| card-r2 | ungraded | 30 | 406465 | 6521 | 345248 | 0 | $0.000000 | 25 | 5 | 0 | 6 | 2 | 93.93s |
| card-r3 | ungraded | 24 | 328635 | 4151 | 231552 | 0 | $0.000000 | 19 | 1 | 0 | 5 | 1 | 63.38s |

## Per-turn metrics

### baseline-r1

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 7 | 44302 | 850 | 6 | 0 | 0 | 18.89s | — | — | 0 | — | — | — | — | — |
| implement | 14 | 321058 | 1741 | 13 | 4 | 0 | 73.48s | — | — | 0 | — | — | — | — | — |
| review | 3 | 77740 | 276 | 2 | 0 | 0 | 12.57s | — | — | 0 | — | — | — | — | — |

### baseline-r2

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 7 | 44272 | 739 | 6 | 0 | 0 | 17.30s | — | — | 0 | — | — | — | — | — |
| implement | 14 | 328104 | 1212 | 13 | 5 | 0 | 57.78s | — | — | 0 | — | — | — | — | — |
| review | 3 | 125354 | 258 | 2 | 0 | 0 | 11.79s | — | — | 0 | — | — | — | — | — |

### baseline-r3

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 3 | 9480 | 1143 | 2 | 0 | 0 | 14.51s | — | — | 0 | — | — | — | — | — |
| implement | 7 | 88592 | 1561 | 6 | 0 | 0 | 29.87s | — | — | 0 | — | — | — | — | — |
| review | 3 | 44593 | 252 | 2 | 0 | 0 | 9.71s | — | — | 0 | — | — | — | — | — |

### card-r1

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 25 | 220461 | 8056 | 22 | 1 | 0 | 357.20s | 1675 | 6575 | 1 | — | full | none | off | none |
| implement | 6 | 109701 | 2262 | 5 | 3 | 0 | 29.24s | 5832 | 9704 | 1 | 1 | full | full | off | disabled |
| review | 1 | 8407 | 236 | 0 | 0 | 0 | 3.79s | 4752 | 3993 | 0 | 1 | full | full | off | disabled |

### card-r2

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 11 | 78775 | 1919 | 8 | 0 | 0 | 25.78s | 1675 | 10979 | 2 | — | full | none | off | none |
| implement | 18 | 319907 | 4252 | 17 | 5 | 0 | 63.39s | 5492 | 13622 | 3 | 1 | full | full | off | disabled |
| review | 1 | 7783 | 350 | 0 | 0 | 0 | 4.77s | 4412 | 2168 | 0 | 1 | full | full | off | disabled |

### card-r3

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 11 | 54071 | 1836 | 8 | 0 | 0 | 25.52s | 1675 | 6575 | 1 | — | full | none | off | none |
| implement | 12 | 251365 | 1937 | 11 | 1 | 0 | 33.53s | 5415 | 19374 | 1 | 1 | full | full | off | disabled |
| review | 1 | 23199 | 378 | 0 | 0 | 0 | 4.32s | 4335 | 14599 | 0 | 1 | full | full | off | disabled |


## Repeated-run distributions

- baseline: 0/3 correct
- card: 0/3 correct

Medians are followed by the observed minimum-to-maximum range.

| Metric | baseline | card | Paired candidate change |
| --- | ---: | ---: | ---: |
| Provider input tokens | 443100 (142665 to 497730) | 338569 (328635 to 406465) | -18.3% (-23.6% to 130.4%) |
| Total tokens | 445967 (145621 to 499939) | 349123 (332786 to 412986) | -17.4% (-21.7% to 128.5%) |
| Output tokens | 2867 (2209 to 2956) | 6521 (4151 to 10554) | 195.2% (40.4% to 268.1%) |
| Reasoning tokens | 0 (0 to 0) | 0 (0 to 0) | n/a |
| Cache-read tokens | 416736 (128128 to 455296) | 246976 (231552 to 345248) | -24.2% (-40.7% to 80.7%) |
| Provider requests | 24 (13 to 24) | 30 (24 to 32) | 33.3% (25% to 84.6%) |
| Tool calls | 21 (10 to 21) | 25 (19 to 27) | 28.6% (19% to 90%) |
| Tool errors | 4 (0 to 5) | 4 (1 to 5) | 0% (0% to 0%) |
| Raw repeated signatures | 2 (0 to 3) | 5 (1 to 6) | 66.7% (-66.7% to 200%) |
| Same-state repeated signatures | 1 (0 to 1) | 1 (1 to 2) | 50% (0% to 100%) |
| Duration (ms) | 86868.5 (54090.1 to 104936.2) | 93932 (63376.2 to 390235.1) | 17.2% (8.1% to 271.9%) |


## Assertions

### baseline-r1


### baseline-r2


### baseline-r3


### card-r1

- PASS: turn 1 — task ID projected
- PASS: turn 1 — snapshot not resumed
- PASS: turn 2 — task ID projected
- FAIL: turn 2 — zero cross-session evidence leases
- PASS: turn 2 — plan revision 1
- PASS: turn 3 — task ID projected
- PASS: turn 3 — zero cross-session evidence leases
- PASS: turn 3 — plan revision 1

### card-r2

- PASS: turn 1 — task ID projected
- PASS: turn 1 — snapshot not resumed
- PASS: turn 2 — task ID projected
- FAIL: turn 2 — zero cross-session evidence leases
- PASS: turn 2 — plan revision 1
- PASS: turn 3 — task ID projected
- PASS: turn 3 — zero cross-session evidence leases
- PASS: turn 3 — plan revision 1

### card-r3

- PASS: turn 1 — task ID projected
- PASS: turn 1 — snapshot not resumed
- PASS: turn 2 — task ID projected
- FAIL: turn 2 — zero cross-session evidence leases
- PASS: turn 2 — plan revision 1
- PASS: turn 3 — task ID projected
- PASS: turn 3 — zero cross-session evidence leases
- PASS: turn 3 — plan revision 1

