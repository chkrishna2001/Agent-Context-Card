# SWE-bench Verified sphinx-doc__sphinx-8593

Generated: 2026-09-16T16:28:13.276Z

| Variant | Correct | Requests | Provider input | Output | Cache read | Cache write | Cost | Tools | Tool errors | Provider errors | Raw repeats | Same-state repeats | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline-r1 | ungraded | 79 | 3096486 | 10193 | 3049984 | 0 | $0.000000 | 76 | 12 | 0 | 14 | 4 | 373.66s |
| baseline-r2 | ungraded | 113 | 8294947 | 24686 | 8176448 | 0 | $0.000000 | 110 | 43 | 0 | 7 | 3 | 592.02s |
| baseline-r3 | ungraded | 52 | 3262530 | 12081 | 3157728 | 0 | $0.000000 | 49 | 18 | 0 | 2 | 2 | 264.25s |
| card-r1 | ungraded | 37 | 602998 | 6909 | 516096 | 0 | $0.000000 | 32 | 13 | 0 | 0 | 0 | 118.13s |
| card-r2 | ungraded | 166 | 4100116 | 36972 | 3364224 | 0 | $0.000000 | 159 | 26 | 0 | 42 | 27 | 790.22s |
| card-r3 | ungraded | 46 | 707227 | 7654 | 582400 | 0 | $0.000000 | 41 | 15 | 0 | 3 | 3 | 124.30s |

## Per-turn metrics

### baseline-r1

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 67 | 2474538 | 8305 | 66 | 12 | 0 | 335.42s | — | — | 0 | — | — | — | — | — |
| implement | 8 | 408604 | 1557 | 7 | 0 | 0 | 27.00s | — | — | 0 | — | — | — | — | — |
| review | 4 | 213344 | 331 | 3 | 0 | 0 | 11.24s | — | — | 0 | — | — | — | — | — |

### baseline-r2

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 75 | 3782177 | 12725 | 74 | 26 | 0 | 326.32s | — | — | 0 | — | — | — | — | — |
| implement | 24 | 2651800 | 8515 | 23 | 10 | 0 | 171.56s | — | — | 0 | — | — | — | — | — |
| review | 14 | 1860970 | 3446 | 13 | 7 | 0 | 94.13s | — | — | 0 | — | — | — | — | — |

### baseline-r3

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 30 | 1117143 | 7066 | 29 | 14 | 0 | 152.42s | — | — | 0 | — | — | — | — | — |
| implement | 19 | 1805364 | 4105 | 18 | 4 | 0 | 86.61s | — | — | 0 | — | — | — | — | — |
| review | 3 | 340023 | 910 | 2 | 0 | 0 | 25.22s | — | — | 0 | — | — | — | — | — |

### card-r1

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 24 | 367784 | 3752 | 21 | 7 | 0 | 72.42s | 1044 | 18791 | 2 | — | full | none | off | none |
| implement | 7 | 187101 | 1622 | 6 | 2 | 0 | 21.83s | 3922 | 20969 | 1 | 1 | full | full | off | disabled |
| review | 6 | 48113 | 1535 | 5 | 4 | 0 | 23.88s | 3459 | 4464 | 0 | 1 | full | full | off | disabled |

### card-r2

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 24 | 513207 | 7287 | 21 | 6 | 0 | 155.82s | 1044 | 31048 | 1 | — | full | none | off | none |
| implement | 72 | 1514772 | 23660 | 68 | 15 | 0 | 358.82s | 4770 | 32913 | 1 | 1 | full | full | off | disabled |
| review | 70 | 2072137 | 6025 | 70 | 5 | 0 | 275.58s | 4429 | 15620 | 0 | 1 | full | full | off | disabled |

### card-r3

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 25 | 419270 | 3648 | 22 | 7 | 0 | 62.41s | 1044 | 29117 | 2 | — | full | none | off | none |
| implement | 4 | 146270 | 922 | 3 | 1 | 0 | 15.66s | 5174 | 30632 | 2 | 1 | full | full | off | disabled |
| review | 17 | 141687 | 3084 | 16 | 7 | 0 | 46.23s | 4711 | 5416 | 0 | 1 | full | full | off | disabled |


## Repeated-run distributions

- baseline: 0/3 correct
- card: 0/3 correct

Medians are followed by the observed minimum-to-maximum range.

| Metric | baseline | card | Paired candidate change |
| --- | ---: | ---: | ---: |
| Provider input tokens | 3262530 (3096486 to 8294947) | 707227 (602998 to 4100116) | -78.3% (-80.5% to -50.6%) |
| Total tokens | 3274611 (3106679 to 8319633) | 714881 (609907 to 4137088) | -78.2% (-80.4% to -50.3%) |
| Output tokens | 12081 (10193 to 24686) | 7654 (6909 to 36972) | -32.2% (-36.6% to 49.8%) |
| Reasoning tokens | 0 (0 to 0) | 0 (0 to 0) | n/a |
| Cache-read tokens | 3157728 (3049984 to 8176448) | 582400 (516096 to 3364224) | -81.6% (-83.1% to -58.9%) |
| Provider requests | 79 (52 to 113) | 46 (37 to 166) | -11.5% (-53.2% to 46.9%) |
| Tool calls | 76 (49 to 110) | 41 (32 to 159) | -16.3% (-57.9% to 44.5%) |
| Tool errors | 18 (12 to 43) | 15 (13 to 26) | -16.7% (-39.5% to 8.3%) |
| Raw repeated signatures | 7 (2 to 14) | 3 (0 to 42) | 50% (-100% to 500%) |
| Same-state repeated signatures | 3 (2 to 4) | 3 (0 to 27) | 50% (-100% to 800%) |
| Duration (ms) | 373664.4 (264245.8 to 592017.6) | 124298.3 (118125.9 to 790224.1) | -53% (-68.4% to 33.5%) |


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

