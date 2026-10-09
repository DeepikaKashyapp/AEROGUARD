import random

import httpx

from server import adaptive
from server.debrief import build_facts, debrief, template_debrief, validate
from server.scoring import score


def test_good_performance_raises_rating_bad_lowers_it():
    r0 = {}
    up, d_up = adaptive.update(r0, {"S1": 0.5}, {"S1": {"p": 0.95, "w": 5}})
    down, d_down = adaptive.update(r0, {"S1": 0.5}, {"S1": {"p": 0.2, "w": 5}})
    assert up["S1"]["rating"] > adaptive.BASE > down["S1"]["rating"]
    assert d_up["S1"] > 0 > d_down["S1"]
    assert up["S2"]["rating"] == adaptive.BASE  # untouched skills don't move


def test_beating_a_hard_mission_counts_more_than_an_easy_one():
    hard, _ = adaptive.update({}, {"S3": 0.9}, {"S3": {"p": 0.8, "w": 5}})
    easy, _ = adaptive.update({}, {"S3": 0.1}, {"S3": {"p": 0.8, "w": 5}})
    assert hard["S3"]["rating"] > easy["S3"]["rating"]


def test_plan_targets_the_weakest_skill_most_often():
    ratings = {s: {"rating": 1100, "n": 5} for s in adaptive.SKILLS}
    ratings["S4"] = {"rating": 900, "n": 5}
    rng = random.Random(0)
    picks = [adaptive.plan_next(ratings, rng, 5)["focus"][0] for _ in range(300)]
    assert picks.count("S4") / len(picks) > 0.5
    assert len(set(picks)) > 1  # still explores


def test_level_tracks_rating():
    assert adaptive.level_for(900) < adaptive.level_for(1100) < adaptive.level_for(1300)


# --------------------------------------------------------------------------
# debrief
# --------------------------------------------------------------------------

def _report(bot_runs, mission="night_swarm_forward_airbase", bot="jam_everything"):
    sc, res = bot_runs[(mission, bot)]
    return sc, res, score(sc, res)


def test_template_debrief_names_mistakes_and_blind_spot(bot_runs):
    sc, res, rep = _report(bot_runs)
    cams = [e.data for e in res.events if e.type == "camera"]
    d = template_debrief(build_facts(sc, rep, [], cams))
    rules = " ".join(m["what"] for m in d["mistakes"])
    assert "jamming" in rules.lower() or "got through" in rules.lower()
    assert d["mistakes"][0]["why"] and d["mistakes"][0]["better"]
    assert d["pattern"] is None or "leakers came from" in d["pattern"]


def test_validator_rejects_invented_numbers_and_tracks(bot_runs):
    sc, _, rep = _report(bot_runs)
    facts = build_facts(sc, rep, [])
    good = template_debrief(facts)
    assert validate(good, facts) == []
    bad = dict(good, summary="You lost 37 aircraft and T-99 escaped.")
    problems = validate(bad, facts)
    assert any("37" in p for p in problems) and any("T-99" in p for p in problems)


def test_llm_output_is_used_only_when_it_validates(bot_runs, monkeypatch):
    sc, _, rep = _report(bot_runs)
    facts = build_facts(sc, rep, [])
    honest = template_debrief(facts)

    def transport(content):
        return httpx.MockTransport(lambda req: httpx.Response(200, json={"choices": [{"message": {"content": content}}]}))

    import json
    monkeypatch.setenv("GROQ_API_KEY", "test")
    ok = debrief(sc, rep, [], client=httpx.Client(transport=transport(json.dumps(honest))))
    assert ok["source"] == "llm"
    lying = dict(honest, summary="Grade A+ with 999 kills.")
    fallback = debrief(sc, rep, [], client=httpx.Client(transport=transport(json.dumps(lying))))
    assert fallback["source"] == "template" and fallback["llm_problems"]
    broken = debrief(sc, rep, [], client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))))
    assert broken["source"] == "template"
