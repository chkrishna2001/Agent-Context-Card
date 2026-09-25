import json
import sys
import time
from pathlib import Path

from laya import Router

HERE = Path(__file__).parent
candidates = json.loads((HERE / "laya_candidates.json").read_text(encoding="utf-8"))

limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(candidates)
candidates = candidates[:limit]

print(f"Loading router (preload)...", file=sys.stderr)
t0 = time.time()
router = Router(preload=True)
print(f"Router loaded in {time.time()-t0:.1f}s", file=sys.stderr)

questions = {
    "still_needed": {
        "type": "noul",
        "instructions": (
            "You are deciding whether the exact content of a file, already read "
            "earlier in a coding assistant's conversation, is still needed in the "
            "assistant's working context, or whether it can be safely dropped now "
            "because the conversation has moved on and nothing since has relied on "
            "it. Answer yes (high probability) if the file's content is still "
            "likely to be needed - for example if the task clearly isn't finished, "
            "the file is central to unresolved work, or the conversation is still "
            "discussing it indirectly even without repeating its exact path. "
            "Answer no (low probability) only if the conversation has clearly moved "
            "past needing that file's content."
        ),
    }
}

results = []
t_start = time.time()
for i, cand in enumerate(candidates):
    state = cand["state"]
    try:
        t0 = time.time()
        out = router.predict(state, questions)
        dt = time.time() - t0
        prob_needed = out["answers"]["still_needed"]["noul"]
    except Exception as e:
        print(f"[{i}] ERROR: {e}", file=sys.stderr)
        prob_needed = None
        dt = None
    results.append(
        {
            **cand,
            "laya_prob_needed": prob_needed,
            "laya_latency_s": dt,
        }
    )
    if i % 10 == 0:
        print(f"[{i}/{len(candidates)}] prob={prob_needed} dt={dt}", file=sys.stderr)

print(f"Total time: {time.time()-t_start:.1f}s for {len(candidates)} examples", file=sys.stderr)

out_path = HERE / "laya_results.json"
out_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
print(f"Wrote {out_path}", file=sys.stderr)
