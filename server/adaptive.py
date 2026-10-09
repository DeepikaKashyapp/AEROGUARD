"""Adaptive difficulty (PLAN.md 6.11).

An Elo-style rating per skill S1..S8. A mission's difficulty on a skill comes
from its skill-load vector (generator.skill_load); after scoring, each skill
the mission exercised moves by K * (performance - expected). The next mission
focuses on the weakest skill (sampled, so it is not always the same one) at a
difficulty where predicted success is about 70%.

Simple and explainable on purpose: an instructor can read why a trainee got
the mission they got.
"""
from __future__ import annotations

import math
import random

from server.contracts import Skill
from server.generator import SKILL_NAMES

BASE = 1000.0
TARGET_SUCCESS = 0.7
SKILLS = [s.value for s in Skill]


def difficulty_rating(load: float) -> float:
    return 800.0 + 600.0 * load


def expected(rating: float, difficulty: float) -> float:
    return 1.0 / (1.0 + 10 ** ((difficulty - rating) / 400.0))


def update(ratings: dict[str, dict], load: dict[str, float], perf: dict[str, dict]) -> tuple[dict[str, dict], dict[str, float]]:
    """Return new ratings and the delta per skill touched."""
    out = {s: dict(ratings.get(s, {"rating": BASE, "n": 0})) for s in SKILLS}
    deltas: dict[str, float] = {}
    for skill, o in perf.items():
        r = out[skill]
        d = difficulty_rating(load.get(skill, 0.3))
        e = expected(r["rating"], d)
        k = 64.0 if r["n"] < 5 else 40.0 if r["n"] < 15 else 28.0
        weight = 0.5 + 0.5 * min(1.0, o["w"] / 5.0)  # more evidence, bigger move
        delta = k * weight * (o["p"] - e)
        r["rating"] = round(r["rating"] + delta, 1)
        r["n"] += 1
        deltas[skill] = round(delta, 1)
    return out, deltas


def level_for(rating: float) -> float:
    """Generator level at which a trainee with this rating is expected to succeed ~70% of the time."""
    d = rating + 400.0 * math.log10(1 / TARGET_SUCCESS - 1)  # expected(rating, d) == TARGET_SUCCESS
    return max(0.05, min(0.95, (d - 800.0) / 600.0))


def plan_next(ratings: dict[str, dict], rng: random.Random, sessions_done: int) -> dict:
    """Pick focus skills and a level for the next adaptive mission, with the reasoning."""
    r = {s: ratings.get(s, {"rating": BASE})["rating"] for s in SKILLS}
    mean = sum(r.values()) / len(r)
    # weaker skills are more likely to be chosen; temperature keeps some exploration
    weights = [math.exp((mean - r[s]) / 40.0) for s in SKILLS]
    focus = [rng.choices(SKILLS, weights=weights)[0]]
    if rng.random() < 0.4:
        rest = [s for s in SKILLS if s != focus[0]]
        focus.append(rng.choices(rest, weights=[math.exp((mean - r[s]) / 40.0) for s in rest])[0])
    level = round(level_for(mean), 3)
    weakest = min(SKILLS, key=lambda s: r[s])
    why = (
        f"Focus: {', '.join(SKILL_NAMES[Skill(s)] for s in focus)}. "
        + (f"Weakest skill so far: {SKILL_NAMES[Skill(weakest)]} (rating {r[weakest]:.0f} vs your average {mean:.0f}). "
           if sessions_done else "First adaptive mission: starting gently. ")
        + f"Difficulty {level:.2f} is set so you should succeed about {int(TARGET_SUCCESS * 100)}% of the time."
    )
    return {"focus": focus, "level": level, "why": why, "ratings": r}
