"""Seed a SYNTHETIC demo course so the dashboards have something to show.

    .venv/bin/python scripts/seed_demo.py [--trainees 6] [--sessions 10] [--reset]

Six simulated trainees (the synthetic_trainee bot, each with a different
weakness) fly 10 sessions each through the real loop: issue (adaptive engine)
-> play (bot on the real sim) -> submit -> score -> skill update. Benchmark B-1
is flown at sessions 1, 5 and 10.

Learning is SIMULATED: after each session the bot's skills grow, a little on
every skill and more on the skills the mission focused on. Everything is
labelled synthetic in the database and the UI (PLAN.md 11: never present
synthetic data as real).
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import service  # noqa: E402
from server.contracts import SessionResult  # noqa: E402
from server.store import Store  # noqa: E402

SKILLS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]

PROFILES = [
    ("Synthetic trainee A", "Maj", {"S1": 0.7, "S2": 0.6, "S3": 0.2, "S4": 0.5, "S5": 0.5, "S6": 0.6, "S7": 0.6, "S8": 0.5}),
    ("Synthetic trainee B", "Lt Col", {"S1": 0.6, "S2": 0.5, "S3": 0.5, "S4": 0.5, "S5": 0.5, "S6": 0.25, "S7": 0.15, "S8": 0.5}),
    ("Synthetic trainee C", "Maj", {"S1": 0.5, "S2": 0.6, "S3": 0.5, "S4": 0.15, "S5": 0.5, "S6": 0.6, "S7": 0.5, "S8": 0.5}),
    ("Synthetic trainee D", "Capt", {s: 0.3 for s in SKILLS}),
    ("Synthetic trainee E", "Maj", {s: 0.65 for s in SKILLS}),
    ("Synthetic trainee F", "Sqn Ldr", {"S1": 0.6, "S2": 0.6, "S3": 0.5, "S4": 0.5, "S5": 0.15, "S6": 0.5, "S7": 0.5, "S8": 0.2}),
]


def play(scenario: dict, skill: dict, seed: int, tmp: Path) -> SessionResult:
    sp, out = tmp / "sc.json", tmp / "res.json"
    sp.write_text(json.dumps(scenario))
    subprocess.run(
        ["node", "bots/src/cli.ts", "--bot", "synthetic_trainee", "--scenario", str(sp), "--out", str(out),
         "--skill-json", json.dumps(skill), "--seed", str(seed)],
        cwd=ROOT, check=True, capture_output=True,
    )
    return SessionResult.model_validate_json(out.read_text())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trainees", type=int, default=6)
    ap.add_argument("--sessions", type=int, default=10)
    ap.add_argument("--reset", action="store_true", help="delete the data directory first")
    ap.add_argument("--data", default=None)
    args = ap.parse_args()

    store_dir = Path(args.data) if args.data else None
    if args.reset:
        d = store_dir or ROOT / "data"
        if d.exists():
            shutil.rmtree(d)
    store = Store(store_dir)
    unit = store.create_unit("Demo course (SYNTHETIC)", synthetic=True)
    rng = random.Random(81)
    now = time.time()
    tmp = Path(tempfile.mkdtemp())
    for name, rank, start in PROFILES[: args.trainees]:
        t = store.create_trainee(name, unit["id"], rank, synthetic=True)
        skill = dict(start)
        for n in range(1, args.sessions + 1):
            ts = now - (args.sessions - n + 1) * 86400 + rng.uniform(0, 3600)
            mode = "benchmark" if n in (1, 5, args.sessions) else "adaptive"
            sess, sc = service.issue_session(store, t["id"], mode, created=ts, rng=rng)
            res = play(sc.model_dump(mode="json"), skill, rng.randint(1, 10_000), tmp)
            rep = service.submit_result(store, sess["id"], res, scored_at=ts + 600)
            focus = [f.value for f in sc.difficulty.focus]
            for s in SKILLS:  # simulated learning: practice helps, focused practice helps more
                gain = 0.07 + (0.10 if s in focus else 0.0)
                skill[s] = round(min(0.97, skill[s] + gain * (1 - skill[s])), 3)
            print(f"{name} #{n:2} {mode:9} {sc.name[:44]:44} {rep['total']:5.1f} {rep['grade']}")
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"seeded unit {unit['id']} into {store.dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
