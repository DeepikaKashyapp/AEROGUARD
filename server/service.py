"""Application logic shared by the API and the demo seeder."""
from __future__ import annotations

import json
import random
import secrets
import statistics
from collections import Counter

from server import adaptive
from server.contracts import Scenario, SessionResult, Skill
from server.debrief import debrief as make_debrief
from server.generator import SKILL_NAMES, fresh_procedural, procedural, scripted
from server.scoring import parse_rules, score
from server.store import Store

BENCHMARK = "benchmark_b1"
FIRST_MISSION = "familiarisation"


class NotFound(Exception):
    pass


class BadRequest(Exception):
    pass


def _rng(seed: int | None = None) -> random.Random:
    return random.Random(seed if seed is not None else secrets.randbits(31))


def issue_session(store: Store, trainee_id: str, mode: str, mission_id: str | None = None, seed: int | None = None,
                  level: float | None = None, focus: list[str] | None = None, aid_mode: str = "off",
                  created: float | None = None, rng: random.Random | None = None) -> tuple[dict, Scenario]:
    trainee = store.get_trainee(trainee_id)
    if not trainee:
        raise NotFound(f"no trainee {trainee_id}")
    rng = rng or _rng()
    plan = None
    if mode == "adaptive":
        done = store.list_sessions(trainee_id)
        if not done:
            sc = scripted(FIRST_MISSION, rng.randint(1, 10_000))
            mission_id = FIRST_MISSION
            plan = {"why": "First session: a gentle daylight familiarisation before the adaptive engine takes over.", "focus": [], "level": 0.15}
        else:
            plan = adaptive.plan_next(store.skills(trainee_id), rng, len(done))
            sc = fresh_procedural(plan["level"], plan["focus"], store.recent_fingerprints(trainee_id), rng)
            mission_id = None
    elif mode == "mission":
        if not mission_id:
            raise BadRequest("mission mode needs mission_id")
        try:
            sc = scripted(mission_id, seed if seed is not None else rng.randint(1, 10_000))
        except KeyError as exc:
            raise NotFound(str(exc)) from exc
    elif mode == "benchmark":
        sc = scripted(BENCHMARK)
        mission_id = BENCHMARK
    elif mode == "drill":
        sc = procedural(seed if seed is not None else rng.randint(1, 2**31 - 1), level if level is not None else 0.4,
                        focus or [], mode="drill")
    else:
        raise BadRequest(f"unknown mode {mode}")
    session = store.create_session(trainee_id, sc, mode, mission_id, aid_mode=aid_mode, plan=plan, created=created)
    return session, sc


def current_rules(store: Store):
    r = store.rules()
    return parse_rules(r["yaml"]), r["version"]


def submit_result(store: Store, session_id: str, result: SessionResult, scored_at: float | None = None) -> dict:
    sess = store.get_session(session_id)
    if not sess:
        raise NotFound(f"no session {session_id}")
    if sess["status"] == "scored":
        raise BadRequest("session already scored")
    sc = store.scenario(session_id)
    if result.scenario_id != sc.id or result.seed != sc.seed:
        raise BadRequest("result does not belong to this session's scenario")
    rules, _ = current_rules(store)
    report = score(sc, result, rules)
    store.save_result(session_id, result, report, scored_at=scored_at)
    if result.ended_reason != "aborted":
        ratings = store.skills(sess["trainee_id"])
        new, deltas = adaptive.update(ratings, {k.value: v for k, v in sc.difficulty.load.items()}, report["skills"])
        store.set_skills(sess["trainee_id"], session_id, new, deltas)
        report["skill_deltas"] = deltas
        store.update_report(session_id, report)
    return report


def get_debrief(store: Store, session_id: str, refresh: bool = False) -> dict:
    sess = store.get_session(session_id)
    if not sess or sess["status"] != "scored":
        raise NotFound("no scored session")
    cached = None if refresh else store.debrief(session_id)
    if cached:
        return cached
    sc = store.scenario(session_id)
    report = store.report(session_id)
    history = [s for s in store.list_sessions(sess["trainee_id"]) if s["id"] != session_id and (s["scored_at"] or 0) < (sess["scored_at"] or 0)]
    cams = [e.data for e in store.result(session_id).events if e.type == "camera"]
    d = make_debrief(sc, report, history[-10:], cams)
    store.save_debrief(session_id, d)
    return d


def _saturation(reports: list[dict]) -> list[dict]:
    buckets: dict[str, list[int]] = {}
    for r in reports:
        for s in r.get("saturation", []):
            n = s["n_active"]
            key = "1-3" if n <= 3 else "4-6" if n <= 6 else "7-10" if n <= 10 else "11+"
            buckets.setdefault(key, []).append(1 if s["ok"] else 0)
    order = ["1-3", "4-6", "7-10", "11+"]
    return [{"bucket": k, "decisions": len(buckets[k]), "good_pct": round(100 * sum(buckets[k]) / len(buckets[k]))} for k in order if k in buckets]


def trends(store: Store, trainee_id: str) -> dict:
    t = store.get_trainee(trainee_id)
    if not t:
        raise NotFound(f"no trainee {trainee_id}")
    sessions = store.list_sessions(trainee_id)
    reports = [store.report(s["id"]) or {} for s in sessions]
    points = []
    for i, s in enumerate(sessions):
        m = s["metrics"] or {}
        points.append({
            "n": i + 1, "id": s["id"], "scored_at": s["scored_at"], "mode": s["mode"], "mission_id": s["mission_id"],
            "name": s["scenario_name"], "total": s["total"], "grade": s["grade"], "stages": s["stages"],
            "level": s["level"], "focus": s["focus"], "benchmark": s["mode"] == "benchmark",
            "night": m.get("night"), "leakers": m.get("leakers"), "detect_latency": m.get("detect_latency_median"),
            "classification_accuracy": m.get("classification_accuracy"), "cost_exchange_ratio": m.get("cost_exchange_ratio"),
            "spent": m.get("spent_total"), "time_to_first_action": m.get("mean_time_to_first_action"),
        })
    ratings = store.skills(trainee_id)
    skills = [{"skill": s.value, "name": SKILL_NAMES[s], "rating": round(ratings.get(s.value, {"rating": adaptive.BASE})["rating"]),
               "n": ratings.get(s.value, {"n": 0})["n"]} for s in Skill]
    hist = store.skill_history(trainee_id)
    conditions = []
    for label, pred in (("Day, clear", lambda p: not p["night"]), ("Night or bad weather", lambda p: p["night"])):
        xs = [p["total"] for p in points if p["night"] is not None and pred(p)]
        if xs:
            conditions.append({"condition": label, "sessions": len(xs), "mean_total": round(statistics.mean(xs), 1)})
    tags = Counter()
    for s in sessions:
        tags.update((s["metrics"] or {}).get("tags", {}))
    tags.pop("good", None)
    bench = [p for p in points if p["benchmark"]]
    return {
        "trainee": t,
        "sessions": points,
        "skills": skills,
        "skill_history": hist,
        "saturation": _saturation(reports),
        "conditions": conditions,
        "tags": dict(tags.most_common()),
        "benchmark": {"first": bench[0]["total"] if bench else None, "last": bench[-1]["total"] if bench else None, "n": len(bench)},
        "synthetic": bool(t["synthetic"]),
    }


def unit_dashboard(store: Store, unit_id: str) -> dict:
    unit = store.get_unit(unit_id)
    if not unit:
        raise NotFound(f"no unit {unit_id}")
    rows = []
    rules = Counter()
    for t in store.list_trainees(unit_id):
        sessions = store.list_sessions(t["id"])
        ratings = store.skills(t["id"])
        bench = [s["total"] for s in sessions if s["mode"] == "benchmark"]
        last3 = [s["total"] for s in sessions[-3:]]
        for s in sessions:
            rules.update((s["metrics"] or {}).get("tags", {}))
        rows.append({
            "id": t["id"], "name": t["name"], "rank": t["rank"], "sessions": len(sessions),
            "last_total": sessions[-1]["total"] if sessions else None,
            "recent_mean": round(statistics.mean(last3), 1) if last3 else None,
            "bench_first": bench[0] if bench else None, "bench_last": bench[-1] if bench else None,
            "skills": {s.value: round(ratings.get(s.value, {"rating": adaptive.BASE})["rating"]) for s in Skill},
        })
    rules.pop("good", None)
    skill_means = {s.value: round(statistics.mean([r["skills"][s.value] for r in rows])) if rows else adaptive.BASE for s in Skill}
    by_n: dict[int, list[float]] = {}
    for t in rows:
        for i, s in enumerate(store.list_sessions(t["id"])):
            if s["mode"] != "benchmark":
                by_n.setdefault(i + 1, []).append(s["total"])
    curve = [{"n": n, "mean_total": round(statistics.mean(v), 1), "trainees": len(v)} for n, v in sorted(by_n.items())]
    weakest = min(skill_means, key=skill_means.get) if rows else None
    return {
        "unit": unit,
        "trainees": rows,
        "skill_names": {s.value: SKILL_NAMES[s] for s in Skill},
        "skill_means": skill_means,
        "weakest_skill": weakest,
        "issues": dict(rules.most_common(8)),
        "curve": curve,
        "synthetic": bool(unit["synthetic"]),
    }


def rules_preview(store: Store, yaml_text: str, limit: int = 40) -> dict:
    try:
        rules = parse_rules(yaml_text)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "rows": []}
    rows = []
    for s in store.list_sessions(limit=10_000)[-limit:]:
        try:
            new = score(store.scenario(s["id"]), store.result(s["id"]), rules)
        except FileNotFoundError:
            continue
        rows.append({"session": s["id"], "trainee": s["trainee_name"], "mission": s["scenario_name"],
                     "old_total": s["total"], "old_grade": s["grade"], "new_total": new["total"], "new_grade": new["grade"]})
    return {"ok": True, "error": None, "rows": rows,
            "mean_change": round(statistics.mean([r["new_total"] - r["old_total"] for r in rows]), 1) if rows else 0}


def session_bundle(store: Store, session_id: str) -> dict:
    """Everything the AAR page needs except the debrief."""
    sess = store.get_session(session_id)
    if not sess:
        raise NotFound(f"no session {session_id}")
    out = {"session": sess, "scenario": json.loads(store.scenario(session_id).model_dump_json())}
    if sess["status"] == "scored":
        res = store.result(session_id)
        out["report"] = store.report(session_id)
        out["replay"] = res.replay.model_dump() if res.replay else None
        out["truth"] = [t.model_dump(mode="json") for t in res.truth]
        out["events"] = [e.model_dump(mode="json") for e in res.events if e.type != "camera"]
        out["trainee"] = store.get_trainee(sess["trainee_id"])
    return out
