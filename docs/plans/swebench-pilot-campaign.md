# SWE-bench pilot campaign (for a paper)

**Status (2026-09-16): tooling built, tested end-to-end, and pushed
(`fc7142a`). The real campaign has NOT been launched yet — only smoke
tests and a 2-instance dry run. Working tree is clean. Next step is simply
to run the command in "How to do it" below.**

## What we're working on

The user wants to publish something (a paper/preprint, "get some notice")
proving `agent-context-card` (ACC) saves tokens on SWE-bench, without
spending the $5-30k a full 500-instance SWE-bench Verified run would cost.
Prior sessions only ever tested 2 SWE-bench instances in depth
(`sympy-18211`, `sympy-21930`) — that reads as anecdote, not evidence, to
anyone SWE-bench-literate.

**Agreed minimum bar, explicitly discussed with the user**: ~20-30 _new_
instances (distinct problems, not more repeats of the same 2), with real
variance reported, is the floor below which "that's just cherry-picked"
sticks regardless of how well-documented the methodology is. Above that,
a small-but-legitimate pilot framing is normal and accepted for a first
preprint — the user does not need 500 instances to be taken seriously,
just enough that the sample itself isn't questionable.

**Cost-avoidance strategy, also explicitly agreed**: run this pilot
through free-tier models via `ai-inference-router` (a local proxy the user
runs, not part of this repo) rather than paid frontier models, since the
router "covers multiple accounts' free tiers" for more effective quota
than one account. Chosen models: `gemma4:31b` (via Ollama Cloud) and
`glm-4.7-flash` (via Cloudflare Workers AI) — both real, citable model
names (unlike the router's opaque `mycoder` alias, deliberately excluded
from this pilot for that reason), both configured at $0 cost in
`models.json`.

**Hard constraint that shaped the tooling**: both backing services are on
free plans that can run out of daily quota mid-campaign. Once that
happens, every subsequent call to that model fails identically until the
quota resets (typically the next day) — the user explicitly asked for a
process that stops cleanly for the day and resumes automatically later,
rather than burning through the remaining queue hitting the same wall.

This pilot is downstream of two other, now-closed investigation threads
from this same multi-day arc — read only if you need the deep background,
not required to continue this thread:

- `docs/plans/repeat-detection-and-eval-harness-followups.md` (bash/grep
  dedup, evidence-ledger reconciliation, SWE-bench grading — all done)
- `docs/notes/haiku-cache-defeat-2026-09-16.md` (a still-unresolved
  Anthropic-specific prompt-caching mystery — irrelevant to this pilot
  since neither `gemma4:31b` nor `glm-4.7-flash` go through Anthropic)

## What we achieved

1. **Fixed `ai-inference-router`'s model config** (outside this repo, at
   `%USERPROFILE%\.pi\agent\models.json` — `C:\Users\chkri\.pi\agent\models.json`
   on this machine. **This file is not version-controlled and a fresh
   clone will not have it** — if it's ever missing/reset, the block below
   needs re-adding). The router originally advertised broken aliases
   (`router-gemma4-31B`, `router-glm-4-7`) that 404'd/400'd against the
   real backends (`prasad-ollama`, `prasad-cf`). Replaced with the real
   model identifiers, confirmed via `ollama.com/library/gemma4:31b` and
   `developers.cloudflare.com/workers-ai/models/glm-4.7-flash/`:

   ```json
   "ai-inference-router": {
     "baseUrl": "http://localhost/AiRouter/v1",
     "apiKey": "air_sJuvU4JfpoH1RoZsinvtmPZ0Wcphb2e",
     "authHeader": true,
     "models": [
       { "id": "mycoder", ... },
       {
         "id": "gemma4:31b",
         "contextWindow": 262144,
         "maxTokens": 8192,
         "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
       },
       {
         "id": "@cf/zai-org/glm-4.7-flash",
         "contextWindow": 131072,
         "maxTokens": 8192,
         "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
       },
       { "id": "allam-2-7b", ... },
       { "id": "openai/gpt-5-nano", ... }
     ]
   }
   ```

   Verified both work with a raw `curl` against `http://localhost/AiRouter/v1/chat/completions`
   **and** end-to-end through the full harness (`run.mjs`, card-only,
   single turn-set): `gemma4:31b` — 17 real tool calls, 118s, fast.
   `glm-4.7-flash` — 59 tool calls, **~1064s (~17.7 min)** for the same
   scope, much slower/chattier. Budget time accordingly — GLM is the
   bottleneck, not gemma4. Both showed only the pre-existing, already-known
   `zeroHotEvidence` FAIL on turn 2 (implement, immediately after plan) —
   not a new bug, an open question already flagged in the followups doc,
   observed across mycoder/gemma4/GLM alike on this specific 3-turn
   fixture shape. No `taskId`/continuity issues on either (the reconnect
   bug from thread 2 above is already fixed).
   The router service itself must be running locally
   (`http://localhost/AiRouter/v1`) for any of this to work — confirmed
   reachable this session, not something this repo controls or starts.

2. **Built `scripts/evaluation/generate-swebench-configs.mjs`** (committed).
   Pulls `problem_statement` directly from `princeton-nlp/SWE-bench_Verified`
   via HuggingFace's `datasets-server` REST API (`https://datasets-server.huggingface.co/rows?...`,
   no auth, 100 rows/page, 500 rows total) instead of hand-writing one JSON
   config per instance (which is what the 2 existing pilot configs did —
   doesn't scale, and hand-paraphrasing 25+ different issues would
   introduce real, uncontrolled bias). Turn prompts embed the dataset's
   `problem_statement` **verbatim** — a deliberate choice, not an
   oversight. Sampling is a seeded shuffle (`mulberry32`, no external
   dependency) — the same `--seed` always reproduces the identical
   instance set from the dataset alone; that's the actual reproducibility
   contract, not just the checked-in files. Already run once:

   ```
   node scripts/evaluation/generate-swebench-configs.mjs --count 25 --seed 20260916 --output evaluation/benchmarks/generated
   ```

   Output committed at `evaluation/benchmarks/generated/*.json` (25
   configs) and `evaluation/benchmarks/generated/manifest.json` (commit
   `fc7142a`). Spans 7 repos (django×10, sympy×6, matplotlib×3, sphinx×2,
   xarray×2, pylint×1, astropy×1) and 3 difficulty tiers (`<15 min fix`×13,
   `15 min - 1 hour`×10, `1-4 hours`×2). All 25 configs validated as
   well-formed JSON matching the existing hand-written schema exactly.

3. **Built `scripts/evaluation/run-campaign.mjs`** (committed) — the
   resumable, quota-aware orchestrator the free-tier constraint requires.
   Takes `--instances <manifest.json>`, `--models <list>` (comma-separated
   `provider/model` strings), `--repeats <n>`, `--output <dir>`. For each
   (model × instance) combo, checks whether
   `<output>/<instanceId>/<safeModelName>/report.json` already has
   `runs.length >= repeats*2` (baseline+card) and skips if so; otherwise
   spawns `run.mjs` as a child process. Classifies each attempt as "bad"
   if it crashed with no usable `report.json`, or if
   `providerErrors/providerRequests > 0.5` for that combo (majority of
   calls errored) — **2 bad combos in a row for the same model** (not 1,
   to avoid stopping over one genuinely hard instance or a transient
   blip) stops the whole campaign with an explicit "rerun this exact same
   command once quota resets" message. **Verified end-to-end this
   session**: a real live run (gemma4:31b, both test instances, n=1)
   completed and was correctly detected as done; re-invoking the _exact
   same command_ skipped both instances with zero new work; an earlier
   version (before a path-resolution bugfix) correctly detected 2
   consecutive crashes and stopped cleanly with the intended message.
   **One real bug found and fixed during testing**: using
   `new URL(import.meta.url).pathname` directly produces a
   double-drive-letter path on Windows (`C:\C:\Users\...`) — fixed by
   switching to `fileURLToPath`
   from `node:url` (matches the existing pattern already used in
   `grade-swebench.mjs`). If this script is ever extended, keep using
   `fileURLToPath` for any script-relative path, never raw `.pathname`.

4. **`evaluation/benchmarks/campaign-instances.json`** (committed) — a
   small 2-instance manifest (the original `sympy-18211`/`sympy-21930`
   configs) used only to test `run-campaign.mjs` itself. Not the real
   pilot manifest — that's `evaluation/benchmarks/generated/manifest.json`.

## What's next

1. **Launch the real campaign** (see exact command below). Nothing is
   blocking this — both models are confirmed working, both scripts are
   tested, the 25-instance manifest exists.
2. **Let it run across however many days the free-tier quota requires.**
   Each time it stops with the "rerun tomorrow" message, just re-run the
   identical command later — no manual bookkeeping needed, already-done
   combos are auto-skipped.
3. **Once all combos are done**, grade correctness for however many
   produced non-empty patches, using the existing WSL Docker path:
   ```
   node scripts/evaluation/grade-swebench.mjs --report <per-instance report.json> --wsl
   ```
   (one `report.json` per instance-model pair, under
   `<campaign-output>/<instanceId>/<safeModelName>/report.json` — this
   needs to be run once per instance/model combo, there's no batch-grading
   script yet; that could be a useful next small tool if this becomes
   tedious at 25+ instances).
4. **Aggregate results** across all instances/models/repeats into
   summary statistics (median/range token and cost change, correctness
   count, variance) — no aggregation script exists yet for
   multi-instance campaigns (the existing `repeatSummary` logic in
   `run.mjs` only aggregates repeats of _one_ instance). This is real,
   not-yet-built work before the numbers are paper-ready.
5. **Publish the raw data, not just aggregates.** `.agent-context-card/e/`
   (all campaign output, including this pilot's) is gitignored — it will
   not survive a fresh clone and is not currently plannable to publish
   as-is. Before writing anything up, decide how the raw session
   logs/reports get published alongside the paper (a companion data
   release — e.g. a public folder or a small HuggingFace/Zenodo dataset —
   was discussed but not decided or built).
6. **Decide whether to include a second, paid/frontier model** for a
   broader generality claim, or keep the pilot free-tier-only. Not
   decided; the user's stated preference was to avoid the $5-30k spend, so
   default to free-tier-only unless told otherwise.

## How to do it

Launch the real pilot (25 instances × 2 models × 3 repeats — adjust
`--repeats` down if GLM's ~18 min/turn-set pace makes n=3 impractical in
one sitting):

```bash
node scripts/evaluation/run-campaign.mjs \
  --instances evaluation/benchmarks/generated/manifest.json \
  --models "ai-inference-router/gemma4:31b,ai-inference-router/@cf/zai-org/glm-4.7-flash" \
  --repeats 3 \
  --output .agent-context-card/e/pilot-25
```

Models are processed in the order listed, all instances for one model
before moving to the next — so gemma4:31b (fast) will finish well before
GLM starts, and a quota stop on GLM won't block gemma4:31b progress made
earlier in the same invocation.

If the router service (`http://localhost/AiRouter/v1`) isn't reachable,
nothing here will work regardless of scripts/config — check that first
(`curl http://localhost/AiRouter/v1/models -H "Authorization: Bearer
air_sJuvU4JfpoH1RoZsinvtmPZ0Wcphb2e"`, expect an HTTP 200 with a model
list) before assuming a quota stop.

To regenerate the same 25-instance sample from scratch (e.g. to verify
reproducibility, or to generate a _different_ sample with a new seed):

```bash
node scripts/evaluation/generate-swebench-configs.mjs --count 25 --seed 20260916 --output evaluation/benchmarks/generated
```

## What we expect from it

- **Don't trust an aggregate percentage without checking the per-instance
  and per-repeat breakdown for spikes.** This exact lesson already burned
  two prior threads in this project this month (a workspace-isolation
  leak that inflated an earlier session's headline number; the Haiku
  caching mystery that made token savings look real while dollar cost
  went the opposite direction). Look at the distribution, not just the
  median, before writing anything up.
- **Report correctness plainly, not just efficiency.** The most recent
  fully-graded SWE-bench result in this project came back tied (1/3
  baseline vs 1/3 card resolved) — efficiency gains do not currently
  imply a correctness edge, and the paper must not imply one without
  actual grading data across this pilot's instances too.
- **n=3 is not automatically enough to trust a single number.** A prior
  n=3 SWE-bench batch on `mycoder` ranged from -74.7% to +50.3% — one
  repeat can flip the entire story. Report medians _and_ ranges, not
  point estimates.
- **The `zeroHotEvidence` turn-2 FAIL on the 3-turn SWE-bench fixture
  shape is still an open, undiagnosed question** (distinct from the
  ten-turn-mixed fixture's version of this, which _was_ resolved earlier
  this month). If it shows up consistently across this pilot's results
  too, that's worth investigating properly rather than ignoring, before
  calling the correctness-assertion machinery trustworthy for a paper's
  methodology section.
- **This doc needs updating again** once the campaign actually starts
  running (even partially) — record real progress numbers, any new
  quota-stop incidents and how long resets actually took in practice, and
  whichever of the "What's next" items get done, rather than letting this
  go stale.
