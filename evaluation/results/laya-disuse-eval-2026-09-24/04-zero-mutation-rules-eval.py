"""
Replays two candidate zero-mutation retirement rules against the same 5 real
CoreApps Pi sessions the Laya evaluation used (see 01-build-candidates.py).
Pure stdlib. Usage: python 04-zero-mutation-rules-eval.py [sessions_dir]

Rule A (REJECTED): retire a read at the first user turn after it unless that
  user message names the file. Measured: 73% of retirements were wrong (the
  path was read or mutated again later).
Rule B (PROPOSED, lossless): retire an older read when a later read of the same
  path returned byte-identical content. The newer read holds the same exact
  evidence, so nothing is lost; measures how many read characters that frees.

Ground truth for "needed again": the same path is read or mutated again later
in the session. This script counts every read event (190), where the Laya note
counts 155, so numbers are directional, not an exact reproduction.
"""
import hashlib
import json
import os
import sys

BASE = sys.argv[1] if len(sys.argv) > 1 else (
    r"C:\Users\chkri\.pi\agent\sessions\--C--Users-chkri-source-repos-CoreApps--"
)
SESSIONS = [
    "2026-09-14T15-24-30-887Z_01a0a085-1327-711e-aeed-6967a2ee135c",
    "2026-09-14T15-11-30-828Z_01a0a079-2c0c-7468-bbac-8662d4bef8fd",
    "2026-09-21T12-05-20-621Z_01a0c3db-3e6c-7550-952f-c3f475b63f46",
    "2026-09-14T09-15-36-907Z_01a09f33-5648-7468-bbac-8661962cd9f6",
    "2026-09-08T08-46-28-453Z_01a08032-8065-7605-9f8b-bb2a60a5db6a",
]
READ = {"read", "view_file"}
MUT = {"edit", "write", "apply_patch", "str_replace", "create_file"}


def load(path):
    events = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "message":
                events.append(obj["message"])
    return events


def text(message):
    content = message.get("content")
    if not isinstance(content, list):
        return str(content or "")
    return " ".join(
        c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"
    )


def calls(message):
    content = message.get("content")
    if not isinstance(content, list):
        return []
    return [c for c in content if isinstance(c, dict) and c.get("type") == "toolCall"]


def path_of(call):
    args = call.get("arguments") or {}
    return args.get("path") or args.get("file_path")


def main():
    rule_a = []  # (session, needed_again)
    reads_total = needed_total = 0
    rule_b = {}
    for sid in SESSIONS:
        name = [f for f in os.listdir(BASE) if sid in f][0]
        events = load(os.path.join(BASE, name))
        label = sid[:10] + sid[-4:]
        user_idx = [i for i, m in enumerate(events) if m.get("role") == "user"]
        results = {m.get("toolCallId"): text(m) for m in events if m.get("role") == "toolResult"}
        reads = []  # (event index, path, content hash, chars)
        for i, message in enumerate(events):
            if message.get("role") != "assistant":
                continue
            for call in calls(message):
                p = path_of(call)
                if p and call.get("name") in READ:
                    body = results.get(call.get("id"), "")
                    reads.append((i, p, hashlib.sha1(body.encode()).hexdigest(), len(body)))
        for k, (i, p, digest, chars) in enumerate(reads):
            needed = any(
                path_of(c) == p and c.get("name") in READ | MUT
                for j, m in enumerate(events)
                if j > i and m.get("role") == "assistant"
                for c in calls(m)
            )
            reads_total += 1
            needed_total += needed
            following = [u for u in user_idx if u > i]
            if following:
                nxt = text(events[following[0]]).lower()
                if p.lower() not in nxt and os.path.basename(p).lower() not in nxt:
                    rule_a.append((label, needed))
        dup = dup_chars = 0
        for k, (i, p, digest, chars) in enumerate(reads):
            if any(pp == p and hh == digest for _, pp, hh, _ in reads[k + 1 :]):
                dup += 1
                dup_chars += chars
        rule_b[label] = (len(reads), dup, sum(r[3] for r in reads), dup_chars)

    wrong = sum(1 for _, needed in rule_a if needed)
    print(f"reads={reads_total} needed_again={needed_total}")
    print(f"Rule A retired={len(rule_a)} needed_again(wrong)={wrong} ({100 * wrong / max(len(rule_a), 1):.0f}%)")
    for label, (n, dup, chars, dup_chars) in rule_b.items():
        print(f"Rule B {label}: reads={n} superseded={dup} read_chars={chars} freed={dup_chars} ({100 * dup_chars / max(chars, 1):.0f}%)")


if __name__ == "__main__":
    main()
