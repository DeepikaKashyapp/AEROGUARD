"""After-action debrief in plain language (PLAN.md 6.13).

The LLM never sees raw logs and never decides anything: it rewrites facts this
module has already computed. A validator rejects any output that cites a
number or track id that is not in those facts, and a deterministic template
debrief is always available (offline / air-gapped deployments, no API key,
or a failed validation).

Provider: Groq's OpenAI-compatible endpoint, as in the Apex Assist agent
(src/agent/reason.py in that repo), selected only when GROQ_API_KEY is set.
"""
from __future__ import annotations

import json
import os
import re
from collections import Counter

import httpx

from server.contracts import Scenario
from server.generator import SKILL_NAMES, _compass
from server.contracts import Skill

MODEL = os.environ.get("AEROGUARD_LLM_MODEL", "llama-3.3-70b-versatile")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

SEVERITY_RANK = {"critical": 0, "major": 1, "minor": 2, "good": 9}

WHY = {
    "FRATRICIDE": "Losing your own aircraft is the worst outcome in an air-defence fight.",
    "FRIENDLY_LINK_LOST": "A jammer covers a whole sector, not one drone: everything with an RF link inside it suffers.",
    "SECTOR_COVERED_FRIENDLY": "A jammer covers a whole sector, not one drone: everything with an RF link inside it suffers.",
    "JAM_UNJAMMABLE": "Fiber-optic and pre-programmed drones have no RF link to jam.",
    "SPOOF_MANUAL": "A drone flown by a pilot over a video link does not need GNSS.",
    "POOR_COST_EXCHANGE": "Cheap drones in numbers exhaust expensive defences: that is the adversary's plan.",
    "EXPENSIVE_ON_DECOY": "Decoys exist to draw expensive munitions before the real strike arrives.",
    "TIGHT_ROE_UNIDENTIFIED": "Weapons tight means hard kill only on a positively identified hostile.",
    "HOLD_WITHOUT_AUTHORITY": "Weapons hold means no hard kill without authority.",
    "CIVIL_HARD_KILL": "Civil drones near a town are a policing problem, not a target.",
    "COLLATERAL": "Rounds and rocket fragments come down somewhere: over a town that means civilian casualties.",
    "SHOT_BIRD": "Every round spent on a bird is attention and ammunition lost.",
    "LEAKER": "It reached the target.",
    "LEAKER_MISSED": "It got through the defence; next time it may not miss.",
    "RECON_COMPLETED": "A recon drone that finishes its orbit makes the strikes that follow it more accurate.",
    "LATE_FIRST_ACTION": "With seconds left, most effectors cannot finish their work in time.",
    "THREAT_IGNORED": "A real threat was dismissed.",
    "ASSET_DESTROYED": "A defended asset was lost.",
    "HEAVY_LOSSES": "Several strikes got through.",
}
BETTER = {
    "FRATRICIDE": "Check IFF and the friendly corridors before any hard kill; if IFF is silent, look at it on the camera.",
    "FRIENDLY_LINK_LOST": "Check the jam sector for own drones first, or use a point effector (laser, gun).",
    "SECTOR_COVERED_FRIENDLY": "Check the jam sector for own and civil drones first, or use a point effector.",
    "JAM_UNJAMMABLE": "No RF strobe on a track means assume RF-silent: go straight to a hard kill.",
    "SPOOF_MANUAL": "Keep GNSS spoofing for pre-programmed fixed-wing drones and decoys.",
    "POOR_COST_EXCHANGE": "Let small drones close to laser or gun range; keep missiles for fixed-wing munitions.",
    "EXPENSIVE_ON_DECOY": "Look at fixed-wing tracks in IR: decoys run cooler and quieter than the real munition.",
    "TIGHT_ROE_UNIDENTIFIED": "Cue the camera and classify before you fire.",
    "HOLD_WITHOUT_AUTHORITY": "Request authority as soon as a threat is classified; it takes several seconds.",
    "CIVIL_HARD_KILL": "Monitor civil drones; jam them only if they threaten the base.",
    "COLLATERAL": "Use the laser over the town, or wait until the target is clear of the zone.",
    "SHOT_BIRD": "Look before you shoot: erratic, flapping, warm but slow usually means a bird.",
    "LEAKER": "Engage earlier and work the track table in time-to-impact order.",
    "LEAKER_MISSED": "Engage earlier and work the track table in time-to-impact order.",
    "RECON_COMPLETED": "Deal with recon drones early: a cheap jam usually works.",
    "LATE_FIRST_ACTION": "Act as soon as a threat is classified; don't let fast movers get inside 10 seconds.",
    "THREAT_IGNORED": "Only 'ignore' tracks you have positively identified as birds or own forces.",
    "ASSET_DESTROYED": "Prioritise by time-to-impact and keep a hard-kill effector free for the closest threat.",
    "HEAVY_LOSSES": "Prioritise by time-to-impact and keep a hard-kill effector free for the closest threat.",
}


# ---------------------------------------------------------------------------
# facts
# ---------------------------------------------------------------------------

def build_facts(sc: Scenario, report: dict, history: list[dict], camera_events: list[dict] | None = None) -> dict:
    """Everything the debrief may say, computed here. `history` is earlier scored sessions (oldest first)."""
    m = report["metrics"]
    wave_brg = {w.id: w.bearing_deg for w in sc.waves}
    leak_tracks = [t for t in report["tracks"] if t["hostile"] and t["outcome"] == "leaked"]
    leak_dirs = Counter(_compass(wave_brg[t["wave"]]) for t in leak_tracks if t["wave"] in wave_brg)
    blind = None
    if leak_dirs:
        direction, n = leak_dirs.most_common(1)[0]
        if n >= 2:
            blind = {"direction": direction, "leakers": n, "of": len(leak_tracks)}
            if camera_events:
                brg = next(w.bearing_deg for w in sc.waves if _compass(w.bearing_deg) == direction)
                looked = sum(1 for e in camera_events if abs(((e["az"] - brg) + 180) % 360 - 180) <= 45)
                blind["camera_pct"] = round(100 * looked / max(1, len(camera_events)))

    mistakes = []
    seen = set()
    for h in sorted(report["hits"], key=lambda h: (SEVERITY_RANK.get(h["severity"], 5), h["points"])):
        if h["severity"] == "good" or (h["points"] >= 0 and h["severity"] != "critical"):
            continue
        if h["rule"] in seen:
            continue
        seen.add(h["rule"])
        mistakes.append({"rule": h["rule"], "track": h["track"], "t": round(h["t"]) if h["t"] is not None else None, "what": h["msg"],
                         "count": sum(1 for x in report["hits"] if x["rule"] == h["rule"])})
        if len(mistakes) >= 4:
            break

    strengths = []
    if (report["stages"].get("detect") or 0) >= 90:
        strengths.append(f"Fast detection: median {m['detect_latency_median']} s from a track appearing to hooking it.")
    if (m.get("classification_accuracy") or 0) >= 0.85:
        strengths.append(f"Accurate classification: {round(100 * m['classification_accuracy'])}% of tracks called correctly.")
    good = [h for h in report["hits"] if h["severity"] == "good"]
    soft = sum(1 for h in good if h["rule"] == "CHEAP_SOFT_KILL")
    if soft:
        strengths.append(f"{soft} cheap soft kill(s) with jamming or spoofing.")
    if m["leakers"] == 0 and m["hostile_total"]:
        strengths.append("Nothing got through to the defended assets.")
    if m.get("cost_exchange_ratio") is not None and m["cost_exchange_ratio"] <= 1:
        strengths.append(f"Good cost-exchange: spent {m['spent_fmt']}, less than the value of the drones stopped.")

    trend = None
    prev = [h for h in history if h.get("total") is not None]
    if len(prev) >= 2:
        first, last = prev[0], prev[-1]
        trend = {
            "sessions": len(prev),
            "first_total": round(first["total"]),
            "last_total": round(last["total"]),
            "now_total": round(report["total"]),
        }
        lat0 = (first.get("metrics") or {}).get("detect_latency_median")
        if lat0 is not None and m.get("detect_latency_median") is not None:
            trend["detect_first"] = lat0
            trend["detect_now"] = m["detect_latency_median"]
        night_leaks = sum((h.get("metrics") or {}).get("leakers", 0) for h in prev if (h.get("metrics") or {}).get("night"))
        all_leaks = sum((h.get("metrics") or {}).get("leakers", 0) for h in prev)
        if all_leaks >= 3:
            trend["night_leak_pct"] = round(100 * night_leaks / all_leaks)
        tags = Counter()
        for h in prev:
            tags.update((h.get("metrics") or {}).get("tags", {}))
        bad = [(k, v) for k, v in tags.most_common() if k not in ("good", "other")]
        if bad:
            trend["recurring_tag"], trend["recurring_count"] = bad[0]

    weakest = None
    if report.get("skills"):
        k, v = min(report["skills"].items(), key=lambda kv: kv[1]["p"])
        if v["p"] < 0.7:
            weakest = {"skill": k, "name": SKILL_NAMES[Skill(k)], "pct": round(100 * v["p"])}

    return {
        "mission": sc.name,
        "conditions": f"{sc.environment.time_of_day.value}, {sc.environment.weather.value}, ROE {sc.roe.state.value.replace('_', ' ')}",
        "grade": report["grade"],
        "total": round(report["total"]),
        "stages": {k: (round(v) if v is not None else None) for k, v in report["stages"].items()},
        "hostile_total": m["hostile_total"],
        "hostile_neutralised": m["hostile_neutralised"],
        "leakers": m["leakers"],
        "spent": m["spent_fmt"],
        "fratricides": m["fratricides"],
        "mistakes": mistakes,
        "strengths": strengths,
        "blind_spot": blind,
        "trend": trend,
        "weakest": weakest,
        "tracks": sorted({t["track"] for t in report["tracks"] if t["track"]}),
    }


# ---------------------------------------------------------------------------
# template debrief (always available)
# ---------------------------------------------------------------------------

def template_debrief(f: dict) -> dict:
    summary = (
        f"{f['mission']} ({f['conditions']}): grade {f['grade']}, {f['total']}/100. "
        f"{f['hostile_neutralised']} of {f['hostile_total']} threats stopped, {f['leakers']} got through, {f['spent']} spent."
    )
    mistakes = []
    for x in f["mistakes"]:
        mistakes.append({
            "track": x["track"], "t": x["t"],
            "what": x["what"] + (f" (x{x['count']})" if x["count"] > 1 else ""),
            "why": WHY.get(x["rule"], ""),
            "better": BETTER.get(x["rule"], ""),
        })
    pattern = None
    if f["blind_spot"]:
        b = f["blind_spot"]
        pattern = f"{b['leakers']} of {b['of']} leakers came from the {b['direction']}"
        if "camera_pct" in b:
            pattern += f", where your camera spent only {b['camera_pct']}% of the mission looking"
        pattern += "."
    elif f["trend"] and "night_leak_pct" in f["trend"] and f["trend"]["night_leak_pct"] >= 60:
        pattern = f"{f['trend']['night_leak_pct']}% of your leakers over recent sessions happened at night or in poor weather."
    elif f["trend"] and f["trend"].get("recurring_tag"):
        pattern = f"Most frequent issue over your recent sessions: {f['trend']['recurring_tag'].replace('_', ' ')} ({f['trend']['recurring_count']} times)."
    progress = None
    if f["trend"]:
        t = f["trend"]
        progress = f"Score {t['first_total']} on your first recorded session, {t['now_total']} today."
        if "detect_first" in t:
            progress += f" Median detection time {t['detect_first']} s then, {t['detect_now']} s now."
    next_drill = (
        f"Next: a mission that works on {f['weakest']['name'].lower()} (you scored {f['weakest']['pct']}% on it today)."
        if f["weakest"] else "Next: a harder mission across all skills."
    )
    return {"source": "template", "summary": summary, "strengths": f["strengths"], "mistakes": mistakes,
            "pattern": pattern, "progress": progress, "next_drill": next_drill}


# ---------------------------------------------------------------------------
# LLM debrief (optional)
# ---------------------------------------------------------------------------

SYSTEM = """You are a directing-staff instructor at a defence staff college, writing a short after-action debrief
for an officer who has just flown a counter-drone training mission. Use ONLY the facts in the JSON you are given.
Do not invent numbers, track ids or events. Be direct and specific, like a good instructor: name the track ids and
times from the facts. Respond with ONLY a JSON object with exactly these keys:
{"summary": "<2 sentences>", "strengths": ["<short>", ...], "mistakes": [{"track": "<id or null>", "t": <seconds or null>,
"what": "<what happened>", "why": "<why it matters>", "better": "<what to do next time>"}], "pattern": "<one sentence or null>",
"progress": "<one sentence or null>", "next_drill": "<one sentence>"}"""


_NUM = re.compile(r"\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?")  # 12,000 and 1,50,000 are one number


def _numbers(text: str) -> list[str]:
    return [n.replace(",", "") for n in _NUM.findall(text)]


def _fact_numbers(f) -> set[float]:
    out: set[float] = set()

    def walk(x):
        if isinstance(x, bool):
            return
        if isinstance(x, (int, float)):
            out.add(round(float(x), 1))
        elif isinstance(x, str):
            out.update(round(float(n), 1) for n in _numbers(x))
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(f)
    return out


def validate(out: dict, f: dict) -> list[str]:
    """Problems with an LLM debrief; empty means it only says things the facts support."""
    problems = []
    for key in ("summary", "strengths", "mistakes", "next_drill"):
        if key not in out:
            problems.append(f"missing {key}")
    text = json.dumps(out, ensure_ascii=False)  # escaped "\u20b912,000" would read as 912
    allowed = _fact_numbers(f) | {0.0, 1.0, 2.0}
    for n in _numbers(text):
        if round(float(n), 1) not in allowed:
            problems.append(f"number {n} not in facts")
    for tid in re.findall(r"T-\d+", text):
        if tid not in f["tracks"]:
            problems.append(f"track {tid} not in facts")
    return problems


def llm_debrief(f: dict, client: httpx.Client | None = None) -> tuple[dict | None, list[str]]:
    key = os.environ.get("GROQ_API_KEY")
    if not key and client is None:
        return None, ["no GROQ_API_KEY"]
    client = client or httpx.Client(timeout=20)
    try:
        r = client.post(GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json={
            "model": MODEL,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(f)}],
        })
        r.raise_for_status()
        out = json.loads(r.json()["choices"][0]["message"]["content"])
    except Exception as exc:  # network, quota, malformed JSON: fall back, never fail the AAR
        return None, [f"llm call failed: {exc.__class__.__name__}"]
    problems = validate(out, f)
    if problems:
        return None, problems
    out["source"] = "llm"
    return out, []


def debrief(sc: Scenario, report: dict, history: list[dict], camera_events: list[dict] | None = None,
            client: httpx.Client | None = None) -> dict:
    facts = build_facts(sc, report, history, camera_events)
    out, problems = llm_debrief(facts, client)
    if out is None:
        out = template_debrief(facts)
        out["llm_problems"] = problems
    out["facts"] = facts
    return out
