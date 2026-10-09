"""Snapshot the server's data for the static preview build (scripts/build_preview.sh).

The preview runs the real sim and console in the browser with no server. What
needs the server (rule-tree scoring, debrief, adaptive engine) is replaced by
recorded responses from the SYNTHETIC demo course, plus pre-generated missions.

    .venv/bin/python scripts/snapshot_preview.py build/preview/snapshot.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import service  # noqa: E402
from server.content import catalogue_json  # noqa: E402
from server.generator import SKILL_NAMES, list_missions, procedural, scripted  # noqa: E402
from server.store import Store  # noqa: E402

MAX_REVIEWS = 14


def thin_replay(bundle: dict) -> dict:
    """Keep every other replay frame (1 Hz) to keep the page small."""
    rp = bundle.get("replay")
    if rp:
        rp["frames"] = rp["frames"][::2]
        rp["dt"] = rp["dt"] * 2
    return bundle


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "build" / "preview" / "snapshot.json")
    store = Store()
    units = [u for u in store.list_units() if u["synthetic"]]
    if not units:
        print("no synthetic unit: run scripts/seed_demo.py first")
        return 1
    unit = units[0]
    trainees = store.list_trainees(unit["id"])

    reviews: dict[str, dict] = {}
    debriefs: dict[str, dict] = {}
    # each trainee's first and latest benchmark (before/after), then a recent adaptive session
    picks: list[str] = []
    for t in trainees:
        sess = store.list_sessions(t["id"])
        bench = [s for s in sess if s["mode"] == "benchmark"]
        adaptive = [s for s in sess if s["mode"] == "adaptive"]
        for s in (bench[:1] + bench[-1:] + adaptive[-1:]):
            if s["id"] not in picks:
                picks.append(s["id"])
    for sid in picks[:MAX_REVIEWS]:
        reviews[sid] = thin_replay(service.session_bundle(store, sid))
        debriefs[sid] = service.get_debrief(store, sid)

    missions = list_missions()
    scenarios = {m["id"]: json.loads(scripted(m["id"], seed=m["fixed_seed"] or 4242).model_dump_json()) for m in missions}
    # adaptive stand-ins: a ladder of procedural missions, each with its focus
    ladder = []
    for i, (level, focus) in enumerate([(0.15, ["S1"]), (0.25, ["S4"]), (0.35, ["S3"]), (0.45, ["S7"]),
                                         (0.55, ["S5"]), (0.6, ["S6"]), (0.7, ["S8"]), (0.8, ["S4", "S5"])]):
        sc = procedural(70_000 + i, level, focus)
        ladder.append({"level": level, "focus": focus, "scenario": json.loads(sc.model_dump_json())})

    rules = store.rules()
    snap = {
        "note": "Recorded from the SYNTHETIC demo course for the static preview.",
        "catalogue": catalogue_json(),
        "aid_model": json.loads((ROOT / "content" / "aid" / "model.json").read_text()),
        "skills": {k.value: v for k, v in SKILL_NAMES.items()},
        "missions": missions,
        "scenarios": scenarios,
        "ladder": ladder,
        "units": units,
        "trainees": trainees,
        "trainee_detail": {t["id"]: {**store.get_trainee(t["id"]), "skills": store.skills(t["id"]), "recent": store.list_sessions(t["id"])[-8:][::-1]} for t in trainees},
        "trends": {t["id"]: service.trends(store, t["id"]) for t in trainees},
        "dashboards": {unit["id"]: service.unit_dashboard(store, unit["id"])},
        "reviews": reviews,
        "debriefs": debriefs,
        "rules": {**rules, "versions": store.rules_versions()},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(snap, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB, {len(reviews)} reviews)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
