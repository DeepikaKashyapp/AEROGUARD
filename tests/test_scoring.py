"""Scoring engine: unit tests plus the bot regression suite (PLAN.md 6.15).

Each baseline bot was built to trip specific rules. If a rules edit or a sim
change stops them doing so, the scoring no longer rewards the decisions the
PS asks for, and these tests say which.
"""
import pytest
from pydantic import ValidationError

from server.scoring import (
    DetectCfg,
    ClassifyCfg,
    classify_points,
    default_rules,
    detect_points,
    fmt,
    inr,
    matches,
    parse_rules,
    score,
)


# --------------------------------------------------------------------------
# units
# --------------------------------------------------------------------------

def test_detect_points_follow_the_ps():
    cfg = DetectCfg()
    assert detect_points(2.0, True, cfg) == 100
    assert detect_points(4.0, True, cfg) == 100
    assert 40 <= detect_points(10.0, True, cfg) < 100
    assert detect_points(15.0, True, cfg) == 40
    assert detect_points(30.0, True, cfg) == 20
    assert detect_points(None, False, cfg) == 0


def test_classify_penalties_are_asymmetric_like_the_ps():
    cfg = default_rules().classify
    bird_as_drone = classify_points("bird", "fpv", False, cfg)
    fpv_as_bird = classify_points("fpv", "bird", True, cfg)
    assert bird_as_drone > fpv_as_bird  # PS: false alarm small, missed FPV big
    assert classify_points("fpv", "fpv", True, cfg) == 100
    assert classify_points("fpv", "unknown", True, cfg) == 50
    assert classify_points("decoy", "made_up", True, ClassifyCfg()) == 85


def test_condition_operators():
    f = {"kind": "rf_jam", "link": "fiber", "n": 3, "x": None, "friendlies_in_sector": 2}
    assert matches({"kind": "rf_jam", "link_in": ["fiber", "none"]}, f)
    assert not matches({"link_not_in": ["fiber"]}, f)
    assert matches({"n_gt": 2, "n_le": 3, "kind_ne": "laser"}, f)
    assert not matches({"x_gt": 1}, f)  # None never compares
    assert matches({"friendlies_in_sector_gt": 0}, f)  # fact name containing "_in"


def test_formatting():
    assert inr(15000000) == "₹1.50 Cr"
    assert inr(1000000) == "₹10 L"
    assert inr(35000) == "₹35,000"
    assert fmt("{a} and {missing}", {"a": 1}) == "1 and ?"
    assert fmt("{a:.0f}", {"a": "not a number"}) == "{a:.0f}"


def test_bad_rules_fail_loudly():
    with pytest.raises(ValidationError):
        parse_rules("rules:\n  - id: X\n    scope: sometimes\n    when: {}\n    then: {}\n")
    with pytest.raises(ValidationError):
        parse_rules("weights: {detect: 1}\nbogus_key: 3\n")


def test_default_rules_cover_every_ps_example():
    ids = {r.id for r in default_rules().rules}
    # detection timing and the bird/FPV asymmetry live in the detect/classify config
    assert {"POOR_COST_EXCHANGE", "JAM_UNJAMMABLE", "FRATRICIDE"} <= ids


# --------------------------------------------------------------------------
# bot regression
# --------------------------------------------------------------------------

def rules_hit(report):
    return {h["rule"] for h in report["hits"] if h["severity"] != "good"}


MISSIONS = ["familiarisation", "night_swarm_forward_airbase", "benchmark_b1", "urban_fringe_roe"]


@pytest.mark.parametrize("mission", MISSIONS)
def test_oracle_aces_every_mission(bot_runs, mission):
    sc, res = bot_runs[(mission, "oracle")]
    rep = score(sc, res)
    assert rep["grade"] == "A", rep["hits"]
    assert rep["metrics"]["leakers"] == 0
    assert not {"FRATRICIDE", "JAM_UNJAMMABLE", "TIGHT_ROE_UNIDENTIFIED", "HOLD_WITHOUT_AUTHORITY", "COLLATERAL"} & rules_hit(rep)


@pytest.mark.parametrize("mission", MISSIONS)
def test_oracle_beats_every_baseline(bot_runs, mission):
    oracle = score(*bot_runs[(mission, "oracle")])["total"]
    for bot in ("passive", "missile_everything", "jam_everything", "trigger_happy"):
        assert score(*bot_runs[(mission, bot)])["total"] < oracle, bot


@pytest.mark.parametrize("mission", MISSIONS)
def test_passive_lets_threats_through(bot_runs, mission):
    rep = score(*bot_runs[(mission, "passive")])
    assert "LEAKER" in rules_hit(rep)
    assert rep["metrics"]["engagements"] == 0
    assert rep["grade"] in ("C", "D", "F")


def test_missile_everything_trips_cost_roe_and_fratricide(bot_runs):
    rep = score(*bot_runs[("night_swarm_forward_airbase", "missile_everything")])
    assert {"TIGHT_ROE_UNIDENTIFIED", "FRATRICIDE"} <= rules_hit(rep)
    assert rep["grade"] == "F"  # PS: shooting a friendly drone is a critical failure
    rep = score(*bot_runs[("urban_fringe_roe", "missile_everything")])
    assert "HOLD_WITHOUT_AUTHORITY" in rules_hit(rep)


def test_jam_everything_wastes_jamming_on_rf_silent_threats(bot_runs):
    rep = score(*bot_runs[("night_swarm_forward_airbase", "jam_everything")])
    assert "JAM_UNJAMMABLE" in rules_hit(rep)
    assert rep["metrics"]["leakers"] > 3
    # ...but jamming is the right call against an RF-heavy raid: the lesson is to adapt
    easy = score(*bot_runs[("familiarisation", "jam_everything")])
    assert easy["total"] > rep["total"] + 20


def test_trigger_happy_shoots_birds_and_breaks_roe(bot_runs):
    rep = score(*bot_runs[("urban_fringe_roe", "trigger_happy")])
    assert {"SHOT_BIRD", "HOLD_WITHOUT_AUTHORITY", "COLLATERAL"} <= rules_hit(rep)
    assert rep["metrics"]["false_alarms"] > 0


def test_report_shape(bot_runs):
    rep = score(*bot_runs[("benchmark_b1", "passive")])
    assert set(rep["stages"]) == {"detect", "classify", "decide_engage", "outcome"}
    t = rep["tracks"][0]
    assert t["path"][0]["stage"] in ("detect", "classify", "engage", "decide", "outcome")
    assert any(p["stage"] == "outcome" for p in t["path"])
    assert rep["hesitation"], "a passive defender should leave hesitation bands"
    assert "S1" in rep["skills"]


def test_rescoring_is_deterministic(bot_runs):
    sc, res = bot_runs[("benchmark_b1", "jam_everything")]
    assert score(sc, res) == score(sc, res)


def test_rules_change_rescores(bot_runs):
    sc, res = bot_runs[("night_swarm_forward_airbase", "jam_everything")]
    text = (default_rules().model_dump_json())
    rules = parse_rules(text)
    for r in rules.rules:
        if r.id == "JAM_UNJAMMABLE":
            r.then.points = 0
    assert score(sc, res, rules)["total"] > score(sc, res)["total"]
