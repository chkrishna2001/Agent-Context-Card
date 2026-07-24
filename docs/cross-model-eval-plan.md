# Cross-model OpenRouter evaluation plan

Companion to `openrouter-models.config.json`. Read this before running anything —
several fields in the config are best-effort and need verification against Pi's
actual model-config schema before the first real run.

## 0. Verify before trusting the config

I don't have Pi's source or its model-config schema in front of me — the shape
above is inferred from:

- the OpenRouter model catalog entry format Pi already exposes (`providers.openrouter.models[].compat`, seen for `google/gemma-4-31b-it`);
- OpenRouter's own API docs for the `provider.order` / `allow_fallbacks` request-level
  pinning fields;
- the existing `off -> none, minimal -> minimal, low -> low` capability map already
  validated for Nano in AGENTS.md.

Unverified / needs a source check before first run:

- **`requestExtra` is a guessed field name.** Pi may expose provider-pinning through
  a differently named key, a top-level `params` block, or not support arbitrary
  passthrough at all. Grep Pi's provider adapter source (or its docs) for how it
  forwards non-standard OpenAI-compatible request fields to OpenRouter, and rename
  accordingly.
- **`thinkingFormat: "openrouter"`** was copied verbatim from the catalog entry
  shown for `google/gemma-4-31b-it` — confirm this is still the current value and
  that it's the mechanism Pi uses to translate `thinking: low` into whatever
  Gemma-via-OpenRouter expects on the wire (may not be `reasoning_effort` at all;
  Gemma's own reasoning control may use a different parameter name than GPT-5's).
- **Do a single manual smoke call to each pinned model before the first gate run**
  and inspect the raw response for a `provider` field matching the pin. This is
  cheap and catches both `requestExtra` misconfiguration and provider-pin failures
  before burning a ten-session gate on a broken config.

## 1. Sequencing

1. Manual smoke-test each of the three models individually (single prompt, single
   call) — confirm response `provider` matches the pin, confirm reasoning/thinking
   field round-trips correctly.
2. Rerun the **unframed baseline** (`pi-ten-turn-mixed.json`, current default
   `full` plan projection) on all three models, n=1 each, to check whether
   stale-plan dominance reproduces on Gemma and Mini, not just Nano. Cheap,
   fast, and tells you whether the header-convention fix eval is worth running
   on all three or just Nano.
3. Only after step 2: proceed to the split-capture header-convention build
   (Step 0 prompt change, then core logic), and run its n=3 controlled gate
   across whichever models showed the failure in step 2.

## 2. Wire verification procedure (OpenRouter-specific)

Replaces the DuckDB router-log audit used for the `mycoder` alias.

1. Every request Pi sends via OpenRouter returns a generation ID in its response.
   Log every generation ID issued during a run (extend the existing audit-isolation
   mechanism — these IDs are non-model-visible telemetry, same category as the
   existing projection audit entries).
2. After the run completes, query `GET https://openrouter.ai/api/v1/generation?id=<id>`
   for each logged ID.
3. Reconcile:
   - count of generation IDs == report's provider-request total (same check
     already used for the router-log audits);
   - every result's `provider` field matches the pin (`openai` / `google`);
   - every result's reasoning/effort field matches what was requested, no
     absent/null values slipping through.
4. Record pass/fail of this reconciliation as a labeled entry, same format as
   the existing `evaluation/results/evidence-ledger.json` audit rows — this
   run generation is "OpenRouter-pinned era," distinct from the prior
   "router era" (`mycoder`) and "direct" language that no longer applies.

## 3. Open item

Free-tier Gemma (`google/gemma-4-31b-it:free`, 20 RPM / 200 RPD) is explicitly
NOT used here — the paid slug is pinned instead, to avoid the same
quota-exhaustion failure mode that invalidated the first `sympy__sympy-21930`
attempt on Ollama Cloud. Confirm billing is set up on the OpenRouter account
before running the full ten-session gate.
