# SWE-bench Verified sympy__sympy-22714

Generated: 2026-09-17T01:22:52.715Z

| Variant | Correct | Requests | Provider input | Output | Cache read | Cache write | Cost | Tools | Tool errors | Provider errors | Raw repeats | Same-state repeats | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline-r1 | ungraded | 16 | 386953 | 2530 | 355616 | 0 | $0.000000 | 13 | 0 | 0 | 0 | 0 | 146.98s |
| baseline-r2 | ungraded | 28 | 1593658 | 6002 | 1504480 | 0 | $0.000000 | 25 | 5 | 0 | 3 | 0 | 97.50s |
| baseline-r3 | ungraded | 18 | 268061 | 3255 | 249856 | 0 | $0.000000 | 15 | 0 | 0 | 0 | 0 | 50.99s |
| card-r1 | ungraded | 20 | 316975 | 3531 | 274080 | 0 | $0.000000 | 17 | 0 | 0 | 0 | 0 | 58.56s |
| card-r2 | ungraded | 39 | 894336 | 6686 | 835584 | 0 | $0.000000 | 34 | 0 | 0 | 1 | 0 | 109.56s |
| card-r3 | ungraded | 30 | 650291 | 5961 | 564832 | 0 | $0.000000 | 25 | 3 | 0 | 3 | 1 | 111.60s |

## Per-turn metrics

### baseline-r1

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 4 | 35001 | 1080 | 3 | 0 | 0 | 85.95s | — | — | 0 | — | — | — | — | — |
| implement | 9 | 257654 | 1170 | 8 | 0 | 0 | 41.85s | — | — | 0 | — | — | — | — | — |
| review | 3 | 94298 | 280 | 2 | 0 | 0 | 19.18s | — | — | 0 | — | — | — | — | — |

### baseline-r2

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 12 | 268671 | 3633 | 11 | 2 | 0 | 43.29s | — | — | 0 | — | — | — | — | — |
| implement | 13 | 1057602 | 1660 | 12 | 3 | 0 | 42.29s | — | — | 0 | — | — | — | — | — |
| review | 3 | 267385 | 709 | 2 | 0 | 0 | 11.92s | — | — | 0 | — | — | — | — | — |

### baseline-r3

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 10 | 123308 | 2056 | 9 | 0 | 0 | 27.79s | — | — | 0 | — | — | — | — | — |
| implement | 5 | 88211 | 908 | 4 | 0 | 0 | 16.58s | — | — | 0 | — | — | — | — | — |
| review | 3 | 56542 | 291 | 2 | 0 | 0 | 6.62s | — | — | 0 | — | — | — | — | — |

### card-r1

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 13 | 189434 | 2425 | 12 | 0 | 0 | 38.18s | 1995 | 11485 | 1 | — | full | none | off | none |
| implement | 6 | 122465 | 742 | 5 | 0 | 0 | 17.15s | 7434 | 13626 | 1 | 1 | full | full | off | disabled |
| review | 1 | 5076 | 364 | 0 | 0 | 0 | 3.23s | 5980 | 2578 | 0 | 1 | full | full | off | disabled |

### card-r2

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 30 | 664347 | 5095 | 27 | 0 | 0 | 78.40s | 1995 | 16627 | 2 | — | full | none | off | none |
| implement | 8 | 225158 | 1262 | 7 | 0 | 0 | 27.59s | 6253 | 18753 | 2 | 1 | full | full | off | disabled |
| review | 1 | 4831 | 329 | 0 | 0 | 0 | 3.57s | 4799 | 2175 | 0 | 1 | full | full | off | disabled |

### card-r3

| Turn | Requests | Provider input | Output | Tools | Tool errors | Provider errors | Duration | Card chars | Projected tokens | Hot evidence | Plan rev. | Plan mode | Plan state | Framing mode | Framing state |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| plan | 17 | 353279 | 4160 | 14 | 1 | 0 | 73.37s | 1995 | 16831 | 2 | — | full | none | off | none |
| implement | 10 | 281478 | 1381 | 9 | 2 | 0 | 30.97s | 6037 | 19182 | 2 | 1 | full | full | off | disabled |
| review | 3 | 15534 | 420 | 2 | 0 | 0 | 7.26s | 4583 | 2385 | 0 | 1 | full | full | off | disabled |


## Repeated-run distributions

- baseline: 0/3 correct
- card: 0/3 correct

Medians are followed by the observed minimum-to-maximum range.

| Metric | baseline | card | Paired candidate change |
| --- | ---: | ---: | ---: |
| Provider input tokens | 386953 (268061 to 1593658) | 650291 (316975 to 894336) | -18.1% (-43.9% to 142.6%) |
| Total tokens | 389483 (271316 to 1599660) | 656252 (320506 to 901022) | -17.7% (-43.7% to 141.9%) |
| Output tokens | 3255 (2530 to 6002) | 5961 (3531 to 6686) | 39.6% (11.4% to 83.1%) |
| Reasoning tokens | 0 (0 to 0) | 0 (0 to 0) | n/a |
| Cache-read tokens | 355616 (249856 to 1504480) | 564832 (274080 to 835584) | -22.9% (-44.5% to 126.1%) |
| Provider requests | 18 (16 to 28) | 30 (20 to 39) | 39.3% (25% to 66.7%) |
| Tool calls | 15 (13 to 25) | 25 (17 to 34) | 36% (30.8% to 66.7%) |
| Tool errors | 0 (0 to 5) | 0 (0 to 3) | -100% (-100% to -100%) |
| Raw repeated signatures | 0 (0 to 3) | 1 (0 to 3) | -66.7% (-66.7% to -66.7%) |
| Same-state repeated signatures | 0 (0 to 0) | 0 (0 to 1) | n/a |
| Duration (ms) | 97499.7 (50989.5 to 146980.4) | 109562 (58558.5 to 111599.9) | 12.4% (-60.2% to 118.9%) |


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

