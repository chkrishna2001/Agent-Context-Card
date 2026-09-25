import json
from pathlib import Path

HERE = Path(__file__).parent
data = json.loads((HERE / "laya_results.json").read_text(encoding="utf-8"))
print("n =", len(data))

missing = [d for d in data if d["laya_prob_needed"] is None]
print("missing laya predictions:", len(missing))
data = [d for d in data if d["laya_prob_needed"] is not None]


def confusion(predict_needed_fn, label):
    tp = fn = fp = tn = 0
    for d in data:
        gt = d["ground_truth_needed_again"]
        pred_needed = predict_needed_fn(d)
        if gt and pred_needed:
            tp += 1
        elif gt and not pred_needed:
            fn += 1
        elif not gt and pred_needed:
            fp += 1
        else:
            tn += 1
    n = tp + fn + fp + tn
    acc = (tp + tn) / n
    recall = tp / (tp + fn) if (tp + fn) else float("nan")
    precision = tp / (tp + fp) if (tp + fp) else float("nan")
    specificity = tn / (tn + fp) if (tn + fp) else float("nan")
    print(f"--- {label} ---")
    print(f"  TP={tp} FN={fn} FP={fp} TN={tn}")
    print(f"  accuracy={acc:.3f}  recall(needed)={recall:.3f}  precision(needed)={precision:.3f}  specificity(correctly-retired)={specificity:.3f}")
    return dict(tp=tp, fn=fn, fp=fp, tn=tn, accuracy=acc, recall=recall, precision=precision, specificity=specificity)


heur = confusion(lambda d: not d["heuristic_would_retire"], "Current heuristic (consumedByDisuse simulation)")
laya_50 = confusion(lambda d: d["laya_prob_needed"] >= 0.5, "Laya @ threshold 0.5")

# calibration check
needed = [d["laya_prob_needed"] for d in data if d["ground_truth_needed_again"]]
not_needed = [d["laya_prob_needed"] for d in data if not d["ground_truth_needed_again"]]
print("\ncalibration:")
print(f"  avg laya prob when GT=needed-again ({len(needed)}): {sum(needed)/len(needed):.3f}")
print(f"  avg laya prob when GT=not-needed-again ({len(not_needed)}): {sum(not_needed)/len(not_needed):.3f}")

# agreement between heuristic and laya
agree = sum(1 for d in data if (not d["heuristic_would_retire"]) == (d["laya_prob_needed"] >= 0.5))
print(f"\nheuristic/laya agree on {agree}/{len(data)} ({agree/len(data):.1%})")

# where they disagree, who's right more often?
disagree = [d for d in data if (not d["heuristic_would_retire"]) != (d["laya_prob_needed"] >= 0.5)]
heur_right_on_disagree = sum(1 for d in disagree if (not d["heuristic_would_retire"]) == d["ground_truth_needed_again"])
laya_right_on_disagree = sum(1 for d in disagree if (d["laya_prob_needed"] >= 0.5) == d["ground_truth_needed_again"])
print(f"\non {len(disagree)} disagreements: heuristic correct {heur_right_on_disagree}, laya correct {laya_right_on_disagree}")

# per-session breakdown
from collections import defaultdict
by_session = defaultdict(list)
for d in data:
    by_session[d["session"]].append(d)
print("\nper-session accuracy (heuristic vs laya):")
for s, rows in by_session.items():
    h_acc = sum(1 for d in rows if (not d["heuristic_would_retire"]) == d["ground_truth_needed_again"]) / len(rows)
    l_acc = sum(1 for d in rows if (d["laya_prob_needed"] >= 0.5) == d["ground_truth_needed_again"]) / len(rows)
    print(f"  {s}: n={len(rows)} heuristic_acc={h_acc:.2f} laya_acc={l_acc:.2f}")

# try a few alternate thresholds for laya to see if better cutoff exists
print("\nlaya threshold sweep:")
for thresh in [0.3, 0.4, 0.5, 0.6, 0.7]:
    r = confusion(lambda d, t=thresh: d["laya_prob_needed"] >= t, f"Laya @ {thresh}")
