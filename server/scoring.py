"""Decision-tree scoring (PLAN.md 6.9).

Deterministic by design (non-negotiable 4): the same event log + the same
rules always give the same score, and every point is traceable to a rule id
and a message. Nothing in here is ML.

Pipeline:
    SessionResult + Scenario --derive()--> per-track facts, per-action facts
    facts + RuleSet         --score()--->  report card (stages, grade, decision
                                           paths, metrics, hesitation bands,
                                           per-skill performance for the
                                           adaptive engine)
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass
from functools import lru_cache
from string import Formatter
from typing import Any, Literal, Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field

from server.content import CONTENT, load_catalogue
from server.contracts import Catalogue, Scenario, SessionResult, Skill

RULES_PATH = CONTENT / "scoring" / "rules.yaml"

# ---------------------------------------------------------------------------
# rule set model (validated so a bad instructor edit fails loudly, not silently)
# ---------------------------------------------------------------------------


class _M(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DetectCfg(_M):
    full_if_latency_le_s: float = 4
    linear_to_s: float = 15
    linear_floor: float = 40
    late_floor: float = 20
    missed: float = 0


class ClassifyCfg(_M):
    unclassified: dict[str, float] = {"hostile": -50, "friendly": -40, "other": -10}
    default_wrong: float = -15
    penalty: dict[str, dict[str, float]] = {}


class RuleThen(_M):
    points: float = 0
    severity: Literal["minor", "major", "critical", "good"] = "minor"
    cap_grade: Optional[Literal["A", "B", "C", "D", "F"]] = None
    tag: str = "other"
    positive: bool = False


class Rule(_M):
    id: str
    scope: Literal["action", "track", "mission"]
    when: dict[str, Any]
    then: RuleThen
    msg: str = ""


class RuleSet(_M):
    version: int = 1
    weights: dict[str, float] = {"detect": 0.2, "classify": 0.2, "decide_engage": 0.4, "outcome": 0.2}
    grades: dict[str, float] = {"A": 85, "B": 70, "C": 55, "D": 40}
    detect: DetectCfg = DetectCfg()
    classify: ClassifyCfg = ClassifyCfg()
    cost_exchange_ratio: float = 15
    rules: list[Rule] = Field(default_factory=list)


def parse_rules(text: str) -> RuleSet:
    return RuleSet.model_validate(yaml.safe_load(text))


@lru_cache(maxsize=1)
def default_rules() -> RuleSet:
    return parse_rules(RULES_PATH.read_text())


# ---------------------------------------------------------------------------
# formatting helpers
# ---------------------------------------------------------------------------

def inr(x: float | None) -> str:
    if x is None:
        return "-"
    if x >= 1e7:
        return f"₹{x / 1e7:.2f} Cr".replace(".00 ", " ")
    if x >= 1e5:
        return f"₹{x / 1e5:.1f} L".replace(".0 ", " ")
    return f"₹{int(round(x)):,}"


LINK_DESC = {"fiber": "fiber-optic", "none": "pre-programmed", "rf": "RF-controlled"}
LABEL_TXT = {
    "bird": "bird", "friendly": "friendly UAV", "civil": "civil drone", "recon": "recon quad",
    "fpv": "FPV", "loitering": "loitering munition", "decoy": "decoy", "unknown": "unknown",
}


class _Safe(dict):
    def __missing__(self, key):
        return "?"


def fmt(template: str, facts: dict) -> str:
    try:
        return Formatter().vformat(template, (), _Safe(facts))
    except Exception:  # a bad format spec in an instructor's rule shouldn't break scoring
        return template


# ---------------------------------------------------------------------------
# facts
# ---------------------------------------------------------------------------

@dataclass
class Derived:
    tracks: list[dict]
    actions: list[dict]
    night: bool
    degraded_windows: list[tuple[float, float]]
    end_t: float


def _degraded_windows(result: SessionResult) -> list[tuple[float, float]]:
    windows, open_at = [], {}
    for ev in result.events:
        if ev.type != "sensor_state":
            continue
        sensor = ev.data.get("sensor")
        if ev.data.get("state") in ("down", "degraded"):
            open_at.setdefault(sensor, ev.t)
        elif sensor in open_at:
            windows.append((open_at.pop(sensor), ev.t))
    windows += [(t, result.duration_s) for t in open_at.values()]
    return windows


def derive(sc: Scenario, result: SessionResult, cat: Catalogue | None = None) -> Derived:
    cat = cat or load_catalogue()
    by_entity: dict[str, list] = {}
    for ev in result.events:
        if ev.entity:
            by_entity.setdefault(ev.entity, []).append(ev)
    results_by_order = {ev.data.get("order"): ev for ev in result.events if ev.type == "engage_result"}
    assets = {a.id: a.name for a in sc.map.assets}
    windows = _degraded_windows(result)
    night = sc.environment.time_of_day != "day" or sc.environment.weather != "clear"

    tracks, actions = [], []
    for tr in result.truth:
        evs = by_entity.get(tr.id, [])
        hook = next((e for e in evs if e.type == "hook"), None)
        classifies = [e for e in evs if e.type == "classify"]
        decisions = [e for e in evs if e.type == "decision"]
        orders = [e for e in evs if e.type == "engage_order"]
        leak = next((e for e in evs if e.type == "leaker"), None)
        t0 = tr.t_first_displayed
        final_label = classifies[-1].data["label"] if classifies else "unknown"
        first_action = min([e.t for e in decisions + orders], default=None)
        first_ev = next((e for e in sorted(decisions + orders, key=lambda e: e.t)), None)
        aff = [e.data.get("effect") for e in evs if e.type == "friendly_affected"]
        f: dict[str, Any] = {
            "entity": tr.id,
            "track": tr.track,
            "true_class": tr.cls.value,
            "true_label": tr.label.value,
            "hostile": tr.hostile,
            "damaging": tr.hostile and tr.damage > 0,
            "link": tr.link.value,
            "link_desc": LINK_DESC[tr.link.value],
            "nav": tr.nav.value,
            "threat_value": tr.cost_inr,
            "threat_value_fmt": inr(tr.cost_inr),
            "wave": tr.wave,
            "tactic": tr.tactic.value if tr.tactic else None,
            "displayed": t0 is not None,
            "t0": t0,
            "hooked": hook is not None,
            "hook_t": hook.t if hook else None,
            "detect_latency": round(hook.t - t0, 2) if hook and t0 is not None else None,
            "final_label": final_label,
            "classified": final_label != "unknown",
            "classified_correctly": final_label == tr.label.value,
            "t_classified": classifies[0].t if classifies else None,
            "relabels": max(0, len(classifies) - 1),
            "camera_used": any(e.type == "camera_designate" for e in evs),
            "decision_final": "engage" if orders else (decisions[-1].data["decision"] if decisions else "none"),
            "n_actions": len(orders),
            "first_action_t": first_action,
            "tti_at_first_action": first_ev.data.get("tti") if first_ev else None,
            "n_active_at_first_action": first_ev.data.get("n_active") if first_ev else None,
            "outcome": tr.outcome.value,
            "outcome_t": tr.outcome_t,
            "outcome_by": tr.outcome_by,
            "damage_done": (leak.data.get("damage") or 0) if leak else 0,
            "asset_name": assets.get(leak.data.get("asset"), "assets") if leak else None,
            "recon_complete": any(e.type == "recon_complete" for e in evs),
            "friendly_link_lost": "link_lost" in aff,
            "friendly_affected": bool(aff),
            "degraded_at_t0": t0 is not None and any(a <= t0 <= b for a, b in windows),
            "night": night,
            "hesitation_s": None,
        }
        if tr.hostile and t0 is not None:
            end = first_action if first_action is not None else (tr.outcome_t or result.duration_s)
            f["hesitation_s"] = round(end - t0, 1)
        # classification-aid use (PLAN.md 6.12)
        aid_cls = [e for e in classifies if e.data.get("aid_label")]
        f["aid_seen"] = bool(aid_cls)
        f["aid_followed"] = [e.data["label"] == e.data["aid_label"] for e in aid_cls]
        f["aid_correct"] = [e.data["aid_label"] == tr.label.value for e in aid_cls]

        spent_total = 0.0
        for o in orders:
            res = results_by_order.get(o.data.get("order"))
            spent = float(res.data.get("spent", 0)) if res else float(o.data.get("est_cost", 0))
            spent_total += spent
            ratio = spent / tr.cost_inr if tr.hostile and tr.cost_inr > 0 else None
            spec = cat.effectors.get(o.data.get("type"))
            a = {
                **f,
                "order": o.data.get("order"),
                "t": o.t,
                "effector": o.data.get("effector"),
                "effector_name": spec.name if spec else o.data.get("effector"),
                "type": o.data.get("type"),
                "kind": o.data.get("kind"),
                "kill": o.data.get("kill"),
                "roe": o.data.get("roe"),
                "label_at_action": o.data.get("label"),
                "authority": o.data.get("authority"),
                "n_active": o.data.get("n_active"),
                "tti": o.data.get("tti"),
                "range": o.data.get("range"),
                "over_nfz": bool(o.data.get("over_nfz")),
                "friendlies_in_sector": o.data.get("friendlies_in_sector", 0),
                "result": res.data.get("result") if res else "unresolved",
                "spent": spent,
                "spent_fmt": inr(spent),
                "action_cost_ratio": round(ratio, 1) if ratio is not None else None,
                "action_cost_ratio_fmt": f"{ratio:.0f}" if ratio is not None else "-",
                "cost_ratio_poor": False,  # set in score() from the rule set's threshold
            }
            actions.append(a)
        f["spent_total"] = spent_total
        f["tti_at_first_action_fmt"] = f"{f['tti_at_first_action']:.0f}" if f["tti_at_first_action"] is not None else "-"
        tracks.append(f)
    return Derived(tracks=tracks, actions=actions, night=night, degraded_windows=windows, end_t=result.duration_s)


# ---------------------------------------------------------------------------
# rule matching
# ---------------------------------------------------------------------------

_SUFFIXES = ("_not_in", "_in", "_gt", "_ge", "_lt", "_le", "_ne")


def _norm(v):
    return getattr(v, "value", v)


def matches(when: dict[str, Any], facts: dict[str, Any]) -> bool:
    for key, want in when.items():
        op, base = "eq", key
        if key not in facts:
            for suf in _SUFFIXES:
                if key.endswith(suf) and key[: -len(suf)] in facts:
                    op, base = suf[1:], key[: -len(suf)]
                    break
        have = _norm(facts.get(base))
        if op == "eq" and have != want:
            return False
        if op == "ne" and have == want:
            return False
        if op == "in" and have not in want:
            return False
        if op == "not_in" and have in want:
            return False
        if op in ("gt", "ge", "lt", "le"):
            if have is None:
                return False
            if op == "gt" and not have > want:
                return False
            if op == "ge" and not have >= want:
                return False
            if op == "lt" and not have < want:
                return False
            if op == "le" and not have <= want:
                return False
    return True


# ---------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------

def detect_points(latency: float | None, hooked: bool, cfg: DetectCfg) -> float:
    if not hooked or latency is None:
        return cfg.missed
    if latency <= cfg.full_if_latency_le_s:
        return 100.0
    if latency <= cfg.linear_to_s:
        k = (latency - cfg.full_if_latency_le_s) / (cfg.linear_to_s - cfg.full_if_latency_le_s)
        return round(100 - k * (100 - cfg.linear_floor), 1)
    return cfg.late_floor


def classify_points(true_label: str, called: str, hostile: bool, cfg: ClassifyCfg) -> float:
    if called == true_label:
        return 100.0
    if called == "unknown":
        key = "hostile" if hostile else "friendly" if true_label == "friendly" else "other"
        return max(0.0, 100 + cfg.unclassified.get(key, -10))
    pen = cfg.penalty.get(true_label, {}).get(called, cfg.default_wrong)
    return max(0.0, 100 + pen)


GRADE_ORDER = ["A", "B", "C", "D", "F"]


def _grade(total: float, bands: dict[str, float]) -> str:
    for g in ("A", "B", "C", "D"):
        if total >= bands.get(g, 101):
            return g
    return "F"


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return round(sum(xs) / len(xs), 1) if xs else None


def score(sc: Scenario, result: SessionResult, rules: RuleSet | None = None, cat: Catalogue | None = None) -> dict:
    rules = rules or default_rules()
    d = derive(sc, result, cat)
    for a in d.actions:
        a["cost_ratio_poor"] = a["action_cost_ratio"] is not None and a["action_cost_ratio"] > rules.cost_exchange_ratio

    hits: list[dict] = []
    track_hits: dict[str, list[dict]] = {}
    action_hits: dict[int, list[dict]] = {}

    def hit(rule: Rule, facts: dict, t: float | None) -> dict:
        h = {
            "rule": rule.id,
            "entity": facts["entity"],
            "track": facts.get("track"),
            "t": t,
            "points": rule.then.points,
            "severity": rule.then.severity,
            "tag": rule.then.tag,
            "cap_grade": rule.then.cap_grade,
            "msg": fmt(rule.msg, facts),
        }
        hits.append(h)
        return h

    for a in d.actions:
        for rule in rules.rules:
            if rule.scope == "action" and matches(rule.when, a):
                action_hits.setdefault(a["order"], []).append(hit(rule, a, a["t"]))
    for f in d.tracks:
        for rule in rules.rules:
            if rule.scope == "track" and matches(rule.when, f):
                track_hits.setdefault(f["entity"], []).append(hit(rule, f, f["outcome_t"]))
    mission = _mission_facts(sc, result, d)
    mission_hits = [hit(rule, mission, None) for rule in rules.rules if rule.scope == "mission" and matches(rule.when, mission)]

    acts_by_entity: dict[str, list[dict]] = {}
    for a in d.actions:
        acts_by_entity.setdefault(a["entity"], []).append(a)

    track_reports = []
    det_scores, cls_scores, de_scores = [], [], []
    for f in sorted(d.tracks, key=lambda x: (x["t0"] if x["t0"] is not None else 1e9, x["entity"])):
        acts = acts_by_entity.get(f["entity"], [])
        bird = f["true_class"] == "bird"
        in_detect = f["hostile"] and f["displayed"]
        in_classify = f["displayed"] and (f["hostile"] or f["true_class"] in ("friendly_uav", "civil_drone") or (bird and (f["classified"] or acts)))
        in_de = (f["hostile"] and (f["displayed"] or f["outcome"] == "leaked")) or (not f["hostile"] and (acts or f["friendly_affected"]))
        if not (in_detect or in_classify or in_de):
            continue
        pts = {"detect": None, "classify": None, "decide_engage": None}
        path = []
        if in_detect:
            pts["detect"] = detect_points(f["detect_latency"], f["hooked"], rules.detect)
            det_scores.append(pts["detect"])
            path.append({
                "stage": "detect", "t": f["hook_t"], "ok": pts["detect"] >= 100, "points": pts["detect"],
                "text": f"Hooked {f['detect_latency']:.1f} s after it appeared" if f["hooked"] else "On the display but never hooked",
            })
        if in_classify:
            pts["classify"] = classify_points(f["true_label"], f["final_label"], f["hostile"], rules.classify)
            cls_scores.append(pts["classify"])
            truth = LABEL_TXT[f["true_label"]] + (f", {f['link_desc']}" if f["true_label"] == "fpv" else "")
            path.append({
                "stage": "classify", "t": f["t_classified"], "ok": f["classified_correctly"], "points": pts["classify"],
                "text": (f"Called it {LABEL_TXT[f['final_label']]}" if f["classified"] else "Never classified") + f" (truth: {truth})",
            })
        if in_de:
            total_pts = 0.0
            for a in acts:
                ah = action_hits.get(a["order"], [])
                total_pts += sum(h["points"] for h in ah)
                path.append({
                    "stage": "engage", "t": a["t"], "points": sum(h["points"] for h in ah),
                    "ok": a["result"] in ("kill", "link_lost", "diverted") and not any(h["points"] < 0 for h in ah),
                    "text": f"{a['effector_name']} → {a['result'].replace('_', ' ')} ({a['spent_fmt']})",
                    "hits": ah,
                })
            if not acts and f["decision_final"] in ("ignore", "monitor"):
                path.append({"stage": "decide", "t": f["first_action_t"], "ok": not f["damaging"], "points": 0, "text": f"Marked '{f['decision_final']}'"})
            th = track_hits.get(f["entity"], [])
            total_pts += sum(h["points"] for h in th)
            pts["decide_engage"] = max(0.0, min(100.0, 100 + total_pts))
            de_scores.append(pts["decide_engage"])
        outcome_txt = {
            "neutralised": f"Neutralised ({f['outcome_by']})",
            "link_lost": f"Link lost, went down ({f['outcome_by']})" if f["true_class"] != "recon_quad" else f"Link lost, turned back ({f['outcome_by']})",
            "diverted": f"Spoofed off course ({f['outcome_by']})",
            "leaked": f"LEAKED: {('hit the ' + f['asset_name']) if f['damage_done'] else 'missed the assets'}",
            "exited": "Left the area" + (" after completing its recon" if f["recon_complete"] else ""),
            "expended": "Reached the target area (harmless decoy)",
            "active": "Still flying at end of mission",
        }[f["outcome"]]
        good_outcome = f["outcome"] in ("neutralised", "link_lost", "diverted") if f["hostile"] else f["outcome"] != "neutralised"
        path.append({"stage": "outcome", "t": f["outcome_t"], "ok": good_outcome and not f["recon_complete"], "points": None,
                     "text": outcome_txt, "hits": track_hits.get(f["entity"], [])})
        track_reports.append({
            "entity": f["entity"], "track": f["track"], "true_class": f["true_class"], "true_label": f["true_label"],
            "hostile": f["hostile"], "link": f["link"], "outcome": f["outcome"], "t0": f["t0"], "wave": f["wave"],
            "tactic": f["tactic"], "points": pts, "path": path,
        })

    outcome = max(0.0, min(100.0, mission["mean_asset_health"] + sum(h["points"] for h in mission_hits)))
    stages = {"detect": _mean(det_scores), "classify": _mean(cls_scores), "decide_engage": _mean(de_scores), "outcome": round(outcome, 1)}
    wsum = sum(rules.weights.get(k, 0) for k, v in stages.items() if v is not None)
    total = round(sum(rules.weights.get(k, 0) * v for k, v in stages.items() if v is not None) / wsum, 1) if wsum else 0.0
    grade = _grade(total, rules.grades)
    capped_by = [h["rule"] for h in hits if h["cap_grade"]]
    for h in hits:
        if h["cap_grade"] and GRADE_ORDER.index(h["cap_grade"]) > GRADE_ORDER.index(grade):
            grade = h["cap_grade"]

    tags: dict[str, int] = {}
    for h in hits:
        tags[h["tag"]] = tags.get(h["tag"], 0) + 1

    metrics = _metrics(d, result, tags, hits)
    return {
        "rules_version": rules.version,
        "total": total,
        "grade": grade,
        "capped_by": capped_by,
        "stages": stages,
        "metrics": metrics,
        "tracks": track_reports,
        "hits": sorted(hits, key=lambda h: (h["t"] if h["t"] is not None else 1e9)),
        "mission_hits": mission_hits,
        "tags": tags,
        "hesitation": _hesitation(d),
        "saturation": [{"n_active": a["n_active"], "ok": not any(h["points"] < 0 for h in action_hits.get(a["order"], []))}
                       for a in d.actions if a["n_active"] is not None],
        "skills": _skills(d, track_reports, action_hits),
        "ai": _ai(d),
    }


def _mission_facts(sc: Scenario, result: SessionResult, d: Derived) -> dict:
    health = result.assets_health or {a.id: 100.0 for a in sc.map.assets}
    worst = min(health, key=health.get) if health else None
    names = {a.id: a.name for a in sc.map.assets}
    hostile = [f for f in d.tracks if f["hostile"]]
    return {
        "entity": None,
        "track": None,
        "min_asset_health": min(health.values()) if health else 100.0,
        "mean_asset_health": sum(health.values()) / len(health) if health else 100.0,
        "worst_asset": names.get(worst, worst),
        "leakers": sum(1 for f in hostile if f["outcome"] == "leaked"),
        "damaging_leakers": sum(1 for f in hostile if f["outcome"] == "leaked" and f["damage_done"] > 0),
        "hostile_total": len(hostile),
        "recon_completed": sum(1 for f in hostile if f["recon_complete"]),
    }


def _metrics(d: Derived, result: SessionResult, tags: dict, hits: list[dict]) -> dict:
    hostile = [f for f in d.tracks if f["hostile"]]
    shown = [f for f in hostile if f["displayed"]]
    lats = sorted(f["detect_latency"] for f in shown if f["detect_latency"] is not None)
    neutral = [f for f in hostile if f["outcome"] in ("neutralised", "link_lost", "diverted")]
    value = sum(f["threat_value"] for f in neutral)
    spent = sum(a["spent"] for a in d.actions)
    cls_tracks = [f for f in d.tracks if f["displayed"] and (f["hostile"] or f["true_class"] in ("friendly_uav", "civil_drone"))]
    return {
        "hostile_total": len(hostile),
        "hostile_displayed": len(shown),
        "hostile_neutralised": len(neutral),
        "leakers": sum(1 for f in hostile if f["outcome"] == "leaked"),
        "damage_total": sum(f["damage_done"] for f in hostile),
        "assets_health": result.assets_health,
        "recon_completed": sum(1 for f in hostile if f["recon_complete"]),
        "fratricides": sum(1 for h in hits if h["rule"] in ("FRATRICIDE", "FRIENDLY_LINK_LOST")),
        "roe_violations": tags.get("roe", 0),
        "collateral": tags.get("collateral", 0),
        "wasted_actions": tags.get("wasted_action", 0),
        "false_alarms": sum(1 for f in d.tracks if f["true_class"] == "bird" and (f["final_label"] not in ("bird", "unknown") or f["n_actions"])),
        "engagements": len(d.actions),
        "spent_total": spent,
        "spent_fmt": inr(spent),
        "threat_value_neutralised": value,
        "cost_exchange_ratio": round(spent / value, 2) if value else None,
        "detect_latency_median": round(statistics.median(lats), 1) if lats else None,
        "detect_latency_p90": round(lats[min(len(lats) - 1, int(0.9 * len(lats)))], 1) if lats else None,
        "classification_accuracy": round(sum(f["classified_correctly"] for f in cls_tracks) / len(cls_tracks), 3) if cls_tracks else None,
        "mean_time_to_first_action": _mean([f["hesitation_s"] for f in shown if f["first_action_t"] is not None]),
        "duration_s": result.duration_s,
        "night": d.night,
    }


def _hesitation(d: Derived, threshold: float = 15) -> list[dict]:
    """Red bands for the replay: a real threat on the display, nobody acting on it."""
    out = []
    for f in d.tracks:
        if not (f["damaging"] or f["true_class"] == "recon_quad") or f["t0"] is None or f["hesitation_s"] is None:
            continue
        if f["hesitation_s"] > threshold:
            out.append({"track": f["track"], "from": round(f["t0"] + threshold, 1), "to": round(f["t0"] + f["hesitation_s"], 1),
                        "acted": f["first_action_t"] is not None})
    return out


def _skills(d: Derived, reports: list[dict], action_hits: dict[int, list[dict]]) -> dict[str, dict]:
    """Per-skill performance p (0..1) and evidence weight w for the Elo update (PLAN.md 6.11)."""
    rep = {r["entity"]: r for r in reports}
    facts = {f["entity"]: f for f in d.tracks}

    def obs(entities, stage):
        vals = [rep[e]["points"][stage] for e in entities if e in rep and rep[e]["points"][stage] is not None]
        return (sum(vals) / len(vals) / 100, len(vals)) if vals else None

    hostile_shown = [e for e, f in facts.items() if f["hostile"] and f["displayed"]]
    out: dict[str, dict] = {}

    def put(skill: Skill, o):
        if o and o[1] > 0:
            out[skill.value] = {"p": round(o[0], 3), "w": o[1]}

    put(Skill.S1, obs(hostile_shown, "detect"))
    put(Skill.S3 if d.night else Skill.S2, obs([e for e in rep if rep[e]["points"]["classify"] is not None], "classify"))
    put(Skill.S4, obs([e for e in rep if facts[e]["hostile"] and facts[e]["link"] != "rf"], "decide_engage"))
    put(Skill.S5, obs([e for e in rep if facts[e]["hostile"] and (facts[e]["n_active_at_first_action"] or 0) >= 6], "decide_engage"))
    # S6: friendly/civil handling + ROE/collateral discipline on every hard kill
    s6 = []
    for e in rep:
        f = facts[e]
        if f["true_class"] in ("friendly_uav", "civil_drone"):
            vals = [v for v in (rep[e]["points"]["classify"], rep[e]["points"]["decide_engage"]) if v is not None]
            if vals:
                s6.append(sum(vals) / len(vals) / 100)
    for a in d.actions:
        if a["kill"] == "hard":
            s6.append(0.0 if any(h["tag"] in ("roe", "collateral", "fratricide") for h in action_hits.get(a["order"], [])) else 1.0)
    if s6:
        out[Skill.S6.value] = {"p": round(sum(s6) / len(s6), 3), "w": len(s6)}
    s7 = [0.0 if any(h["tag"] == "cost_exchange" for h in action_hits.get(a["order"], [])) else 1.0 for a in d.actions if a["hostile"]]
    if s7:
        out[Skill.S7.value] = {"p": round(sum(s7) / len(s7), 3), "w": len(s7)}
    deg = [e for e in hostile_shown if facts[e]["degraded_at_t0"]]
    o1, o2 = obs(deg, "detect"), obs(deg, "decide_engage")
    if o1 or o2:
        ps = [o[0] for o in (o1, o2) if o]
        put(Skill.S8, (sum(ps) / len(ps), len(deg)))
    return out


def _ai(d: Derived) -> dict:
    right_follow = right_total = wrong_override = wrong_total = 0
    for f in d.tracks:
        for followed, correct in zip(f["aid_followed"], f["aid_correct"]):
            if correct:
                right_total += 1
                right_follow += followed
            else:
                wrong_total += 1
                wrong_override += not followed
    return {
        "suggestions_acted_on": right_total + wrong_total,
        "agree_when_right": round(right_follow / right_total, 3) if right_total else None,
        "override_when_wrong": round(wrong_override / wrong_total, 3) if wrong_total else None,
    }
