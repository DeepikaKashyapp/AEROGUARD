"""Train the classification aid (PLAN.md 6.12) and export it for the browser.

    .venv/bin/python scripts/train_aid.py [--scenarios 160]

1. Generates procedural scenarios across levels and focus skills.
2. Plays them headless (bots/src/dump_features.ts) and samples per-track
   features with the true label.
3. Fits a multinomial logistic regression on standardised features, then a
   temperature on a held-out calibration split (scenario-level splits, so no
   mission leaks between train and test).
4. Reports accuracy, per-class recall and expected calibration error (ECE)
   on a held-out test split, and writes content/aid/model.json.
"""
from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.generator import SKILLS, procedural  # noqa: E402

FEATURES = ["speed", "speed_sd", "agl", "climb_abs", "hover_frac", "rf_any", "rf_58", "rf_24", "rf_link", "ac_heard",
            "iff_friend", "iff_none", "thermal", "thermal_known", "range_km", "closing"]
CLASSES = ["bird", "friendly", "civil", "recon", "fpv", "loitering", "decoy"]
OUT = ROOT / "content" / "aid" / "model.json"


def softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def ece(probs: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    conf = probs.max(axis=1)
    pred = probs.argmax(axis=1)
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf > lo) & (conf <= hi)
        if m.any():
            total += m.mean() * abs((pred[m] == y[m]).mean() - conf[m].mean())
    return float(total)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenarios", type=int, default=160)
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp())
    rng = random.Random(7)
    for i in range(args.scenarios):
        level = rng.random()
        focus = rng.sample(SKILLS, k=rng.choice([0, 1, 2]))
        # birds, friendlies and civil drones are rarer than threats: lean on the skills that add them
        if rng.random() < 0.35:
            focus = list({*focus, "S1", "S6"})
        sc = procedural(10_000 + i, level, focus)
        (tmp / f"{sc.id}.json").write_text(sc.model_dump_json())
    feats = tmp / "features.jsonl"
    subprocess.run(["node", "bots/src/dump_features.ts", "--scenarios", str(tmp), "--out", str(feats)], cwd=ROOT, check=True)

    rows = [json.loads(line) for line in feats.read_text().splitlines() if line.strip()]
    X = np.array([r["x"] for r in rows], dtype=float)
    y = np.array([CLASSES.index(r["y"]) for r in rows])
    scen = np.array([r["s"] for r in rows])
    ids = sorted(set(scen))
    random.Random(1).shuffle(ids)
    n = len(ids)
    train_ids, cal_ids, test_ids = set(ids[: int(0.6 * n)]), set(ids[int(0.6 * n): int(0.8 * n)]), set(ids[int(0.8 * n):])
    tr = np.isin(scen, list(train_ids))
    ca = np.isin(scen, list(cal_ids))
    te = np.isin(scen, list(test_ids))

    mean = X[tr].mean(axis=0)
    std = X[tr].std(axis=0)
    std[std < 1e-6] = 1.0
    Z = (X - mean) / std
    # class-balanced: birds are plentiful, threats are what matter
    clf = LogisticRegression(max_iter=3000, C=2.0, class_weight="balanced")
    clf.fit(Z[tr], y[tr])
    logits = Z @ clf.coef_.T + clf.intercept_

    # temperature scaling on the calibration split
    best_t, best_nll = 1.0, float("inf")
    for t in np.linspace(0.4, 4.0, 73):
        p = softmax(logits[ca] / t)
        nll = -np.log(p[np.arange(ca.sum()), y[ca]] + 1e-12).mean()
        if nll < best_nll:
            best_t, best_nll = float(t), nll
    p_test_raw = softmax(logits[te])
    p_test = softmax(logits[te] / best_t)
    acc = accuracy_score(y[te], p_test.argmax(axis=1))
    cm = confusion_matrix(y[te], p_test.argmax(axis=1), labels=list(range(len(CLASSES))))
    recall = {c: (round(float(cm[i, i] / cm[i].sum()), 3) if cm[i].sum() else None) for i, c in enumerate(CLASSES)}
    night = np.array([r["night"] for r in rows])[te]
    acc_night = accuracy_score(y[te][night], p_test.argmax(axis=1)[night]) if night.any() else None
    acc_day = accuracy_score(y[te][~night], p_test.argmax(axis=1)[~night]) if (~night).any() else None
    metrics = {
        "samples": int(len(y)),
        "scenarios": n,
        "test_samples": int(te.sum()),
        "accuracy": round(float(acc), 3),
        "balanced_accuracy": round(float(np.mean([v for v in recall.values() if v is not None])), 3),
        "accuracy_day": round(float(acc_day), 3) if acc_day is not None else None,
        "accuracy_night_or_weather": round(float(acc_night), 3) if acc_night is not None else None,
        "ece_before_calibration": round(ece(p_test_raw, y[te]), 3),
        "ece": round(ece(p_test, y[te]), 3),
        "temperature": round(best_t, 3),
        "recall": recall,
        "confusion": cm.tolist(),
        "class_counts": {c: int((y == i).sum()) for i, c in enumerate(CLASSES)},
    }
    model = {
        "features": FEATURES,
        "classes": CLASSES,
        "mean": [round(float(v), 5) for v in mean],
        "std": [round(float(v), 5) for v in std],
        "coef": [[round(float(v), 5) for v in row] for row in clf.coef_],
        "intercept": [round(float(v), 5) for v in clf.intercept_],
        "temperature": round(best_t, 4),
        "metrics": metrics,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(model, indent=1))
    print(json.dumps(metrics, indent=1))
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
