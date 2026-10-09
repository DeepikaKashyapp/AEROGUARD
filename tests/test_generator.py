import random

import pytest

from server.contracts import DroneClass, RoeState, Skill, TimeOfDay
from server.generator import fresh_procedural, list_missions, procedural, scripted


def test_all_scripted_missions_load():
    ids = {m["id"] for m in list_missions()}
    assert {"night_swarm_forward_airbase", "familiarisation", "benchmark_b1", "urban_fringe_roe"} <= ids
    for m in ids:
        sc = scripted(m, seed=3)
        assert sc.waves and sc.sensors and sc.effectors
        assert sc.fingerprint


def test_scripted_randomise_varies_by_seed_but_benchmark_is_fixed():
    a, b = scripted("night_swarm_forward_airbase", 1), scripted("night_swarm_forward_airbase", 2)
    assert [w.bearing_deg for w in a.waves] != [w.bearing_deg for w in b.waves]
    x, y = scripted("benchmark_b1", 1), scripted("benchmark_b1", 999)
    assert x.model_dump_json() == y.model_dump_json()
    assert x.seed == 2026


@pytest.mark.parametrize("level", [0.0, 0.3, 0.7, 1.0])
def test_procedural_is_deterministic(level):
    assert procedural(42, level, ["S4"]).model_dump_json() == procedural(42, level, ["S4"]).model_dump_json()


def test_difficulty_scales_threat_count():
    def mean_threats(level):
        return sum(sum(u.n for w in procedural(s, level).waves for u in w.units) for s in range(40)) / 40
    assert mean_threats(1.0) > mean_threats(0.5) > mean_threats(0.0)


def test_focus_skills_shape_the_mission():
    def share(pred, **kw):
        return sum(pred(procedural(s, 0.5, **kw)) for s in range(60)) / 60

    night = lambda sc: sc.environment.time_of_day == TimeOfDay.night
    assert share(night, focus=[Skill.S3]) > share(night, focus=[]) + 0.2

    def silent(sc):
        units = [(u.cls, u.n) for w in sc.waves for u in w.units]
        tot = sum(n for _, n in units)
        return sum(n for c, n in units if c in (DroneClass.fpv_fiber, DroneClass.loitering_munition, DroneClass.decoy)) / tot
    assert share(silent, focus=[Skill.S4]) > share(silent, focus=[]) + 0.15

    hold = lambda sc: sc.roe.state == RoeState.weapons_hold
    assert share(hold, focus=[Skill.S6]) > 0.3
    assert share(hold, focus=[]) == 0

    degraded = lambda sc: any(s.events for s in sc.sensors)
    assert share(degraded, focus=[Skill.S8]) > 0.6


def test_skill_load_reflects_focus():
    sc = procedural(11, 0.6, [Skill.S8])
    assert sc.difficulty.load[Skill.S8] > 0
    assert all(0 <= v <= 1 for v in sc.difficulty.load.values())


def test_fingerprints_rarely_collide_and_fresh_avoids_recent():
    fps = {procedural(s, 0.5).fingerprint for s in range(200)}
    assert len(fps) >= 190
    first = procedural(5, 0.5)
    rng = random.Random(1)
    sc = fresh_procedural(0.5, [], {first.fingerprint}, rng)
    assert sc.fingerprint != first.fingerprint


def test_duration_is_bounded():
    for s in range(50):
        sc = procedural(s, s / 49)
        assert 240 <= sc.duration_s <= 720
