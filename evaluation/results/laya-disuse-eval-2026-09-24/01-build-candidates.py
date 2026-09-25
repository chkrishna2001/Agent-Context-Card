"""
Offline evaluation: does Laya (a calibrated small decision model) predict
"is this read still needed" better than agent-context-card's current
consumedByDisuse heuristic (exact lowercase path-substring match)?

Ground truth is derived deterministically from the FULL session transcript
(hindsight): a read is "needed again" if the same file path is read or
mutated again later in the SAME session. That's the actual thing retirement
is trying to predict without hindsight.
"""
import json
import sys
from pathlib import Path

SESSION_FILES = [
    r"C:\Users\chkri\.pi\agent\sessions\--C--Users-chkri-source-repos-CoreApps--\2026-09-14T15-24-30-887Z_01a0a085-1327-711e-aeed-6967a2ee135c.jsonl",
    r"C:\Users\chkri\.pi\agent\sessions\--C--Users-chkri-source-repos-CoreApps--\2026-09-14T15-11-30-828Z_01a0a079-2c0c-7468-bbac-8662d4bef8fd.jsonl",
    r"C:\Users\chkri\.pi\agent\sessions\--C--Users-chkri-source-repos-CoreApps--\2026-09-21T12-05-20-621Z_01a0c3db-3e6c-7550-952f-c3f475b63f46.jsonl",
    r"C:\Users\chkri\.pi\agent\sessions\--C--Users-chkri-source-repos-CoreApps--\2026-09-14T09-15-36-907Z_01a09f33-5648-7468-bbac-8661962cd9f6.jsonl",
    r"C:\Users\chkri\.pi\agent\sessions\--C--Users-chkri-source-repos-CoreApps--\2026-09-08T08-46-28-453Z_01a08032-8065-7605-9f8b-bb2a60a5db6a.jsonl",
]

READ_TOOLS = {"read", "view_file"}
MUTATION_TOOLS = {"edit", "write", "apply_patch", "str_replace", "create_file"}


def load_events(path):
    events = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "message":
                continue
            events.append(obj["message"])
    return events


def content_items(message):
    return message.get("content") or []


def first_text(message):
    for item in content_items(message):
        if item.get("type") == "text":
            return item.get("text") or ""
    return ""


def tool_call_items(message):
    return [c for c in content_items(message) if c.get("type") == "toolCall"]


def build_candidates(events):
    """Return list of dicts: {idx, path, session_context}."""
    candidates = []
    first_user_text = ""
    for m in events:
        if m.get("role") == "user" and not first_user_text:
            first_user_text = first_text(m)
            break

    for idx, m in enumerate(events):
        if m.get("role") != "assistant":
            continue
        for call in tool_call_items(m):
            name = call.get("name")
            if name not in READ_TOOLS:
                continue
            args = call.get("arguments") or {}
            path = args.get("path")
            if not path:
                continue
            call_id = call.get("id")
            # find matching toolResult
            result_idx = None
            for j in range(idx + 1, min(idx + 4, len(events))):
                rm = events[j]
                if rm.get("role") == "toolResult" and rm.get("toolCallId", rm.get("toolcallid")) == call_id:
                    result_idx = j
                    break
            if result_idx is None:
                # fallback: next toolResult regardless of id match field casing
                for j in range(idx + 1, min(idx + 4, len(events))):
                    if events[j].get("role") == "toolResult":
                        result_idx = j
                        break
            if result_idx is None:
                continue
            if events[result_idx].get("isError") or events[result_idx].get("iserror"):
                continue
            candidates.append(
                {
                    "idx": idx,
                    "result_idx": result_idx,
                    "path": path,
                    "goal": first_user_text,
                }
            )
    return candidates


def ground_truth_needed_again(events, candidate):
    path_lower = candidate["path"].lower()
    for m in events[candidate["result_idx"] + 1 :]:
        if m.get("role") != "assistant":
            continue
        for call in tool_call_items(m):
            args = call.get("arguments") or {}
            p = (args.get("path") or "").lower()
            if p == path_lower and call.get("name") in (READ_TOOLS | MUTATION_TOOLS):
                return True, call.get("name")
    return False, None


def heuristic_would_retire(events, candidate):
    """Mirrors consumedByDisuse: graceObserved (any later successful call)
    AND NOT referencedAfter (exact path substring in later assistant text
    or tool-call arguments)."""
    path_lower = candidate["path"].lower()
    grace_observed = False
    referenced_after = False
    for m in events[candidate["result_idx"] + 1 :]:
        if m.get("role") == "toolResult":
            if not (m.get("isError") or m.get("iserror")):
                grace_observed = True
            continue
        if m.get("role") != "assistant":
            continue
        text = first_text(m)
        if text and path_lower in text.lower():
            referenced_after = True
        for call in tool_call_items(m):
            args_str = json.dumps(call.get("arguments") or {}).lower()
            if path_lower in args_str:
                referenced_after = True
    if grace_observed and not referenced_after:
        return True  # heuristic retires it
    return False


def build_state_text(events, candidate, max_chars=900):
    """What has happened since the read, up to the next couple of turns -
    the information available at decision time (no hindsight)."""
    parts = []
    goal = candidate["goal"][:300]
    parts.append(f"Task: {goal}")
    parts.append(f"A file was read: {candidate['path']}")
    since = []
    chars = 0
    for m in events[candidate["result_idx"] + 1 :]:
        if m.get("role") == "user":
            t = first_text(m)
            if t:
                since.append(f"User: {t}")
                chars += len(t)
        elif m.get("role") == "assistant":
            t = first_text(m)
            if t:
                since.append(f"Assistant: {t}")
                chars += len(t)
            else:
                calls = tool_call_items(m)
                if calls:
                    since.append(f"Assistant called: {calls[0].get('name')}")
        if chars > max_chars or len(since) >= 6:
            break
    parts.append("What happened since that read:")
    parts.extend(since)
    return "\n".join(parts)[: max_chars + 400]


def main():
    all_candidates = []
    for sf in SESSION_FILES:
        p = Path(sf)
        if not p.exists():
            print(f"MISSING: {sf}", file=sys.stderr)
            continue
        events = load_events(p)
        cands = build_candidates(events)
        for c in cands:
            gt, gt_kind = ground_truth_needed_again(events, c)
            heur_retire = heuristic_would_retire(events, c)
            state = build_state_text(events, c)
            all_candidates.append(
                {
                    "session": p.name,
                    "path": c["path"],
                    "ground_truth_needed_again": gt,
                    "ground_truth_kind": gt_kind,
                    "heuristic_would_retire": heur_retire,
                    "state": state,
                }
            )
        print(f"{p.name}: {len(cands)} read candidates", file=sys.stderr)

    out = Path(__file__).parent / "laya_candidates.json"
    out.write_text(json.dumps(all_candidates, indent=2), encoding="utf-8")
    print(f"Total candidates: {len(all_candidates)}", file=sys.stderr)
    print(f"Wrote {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
