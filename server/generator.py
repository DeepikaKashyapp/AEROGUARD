"""Scenario generation (PLAN.md 6.2).

Two sources, one schema:
  - scripted missions in content/missions/*.yaml, optionally jittered by a
    `randomise:` block so even scripted missions don't repeat exactly;
  - procedural missions built from (seed, level, focus skills).

Both are deterministic: the same inputs give a byte-identical Scenario. The
enemy *behaviour* (boids, flanking, decoy timing, time-on-target) lives in the
sim; the generator only picks which tactics, numbers, axes and conditions a
mission gets.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from functools import lru_cache
from pathlib import Path
from typing import Iterable

import yaml

from server.content import CONTENT, load_catalogue
from server.contracts import (
    Clutter,
    DroneClass,
    EffectorPlacement,
    Environment,
    FriendlyFlight,
    MapSpec,
    Roe,
    RoeState,
    Scenario,
    SensorEvent,
    SensorPlacement,
    Skill,
    Tactic,
    TimeOfDay,
    Wave,
    WaveUnit,
    Weather,
)

MISSIONS_DIR = CONTENT / "missions"
SKILLS = list(Skill)

SKILL_NAMES = {
    Skill.S1: "Detection in clutter",
    Skill.S2: "Classification by day",
    Skill.S3: "Classification at night / in weather",
    Skill.S4: "RF-silent threats",
    Skill.S5: "Swarm saturation",
    Skill.S6: "Friendly/civil discrimination and ROE",
    Skill.S7: "Cost-exchange discipline",
    Skill.S8: "Degraded-sensor operations",
}


# ---------------------------------------------------------------------------
# scripted missions
# ---------------------------------------------------------------------------

@lru_cache(maxsize=None)
def _mission_raw(mission_id: str) -> dict:
    path = MISSIONS_DIR / f"{mission_id}.yaml"
    if not path.exists():
        raise KeyError(f"no mission {mission_id!r}")
    return yaml.safe_load(path.read_text())


def list_missions() -> list[dict]:
    out = []
    for path in sorted(MISSIONS_DIR.glob("*.yaml")):
        raw = _mission_raw(path.stem)
        out.append({
            "id": path.stem,
            "name": raw["name"],
            "mode": raw.get("mode", "scripted"),
            "tags": raw.get("tags", []),
            "briefing": raw.get("briefing", ""),
            "time_of_day": raw["environment"]["time_of_day"],
            "weather": raw["environment"]["weather"],
            "roe": raw["roe"]["state"],
            "fixed_seed": raw.get("fixed_seed"),
        })
    return out


def scripted(mission_id: str, seed: int | None = None) -> Scenario:
    raw = json.loads(json.dumps(_mission_raw(mission_id)))  # deep copy
    fixed = raw.pop("fixed_seed", None)
    seed = fixed if fixed is not None else (seed if seed is not None else 1)
    rnd = raw.pop("randomise", None)
    rng = random.Random(seed)
    if rnd and fixed is None:
        tj = float(rnd.get("time_jitter_s", 0))
        bj = float(rnd.get("bearing_jitter_deg", 0))
        for w in raw["waves"]:
            w["t"] = round(max(0.0, w["t"] + rng.uniform(-tj, tj)), 1)
            w["bearing_deg"] = round((w["bearing_deg"] + rng.uniform(-bj, bj)) % 360, 1)
        raw["map"]["terrain_seed"] = raw["map"]["terrain_seed"] + rng.randint(0, 9)
    sc = Scenario(id=f"{mission_id}-{seed}", seed=seed, **raw)
    sc.difficulty.load = skill_load(sc)
    sc.fingerprint = fingerprint(sc)
    return sc


# ---------------------------------------------------------------------------
# procedural missions
# ---------------------------------------------------------------------------

LAYOUTS = [
    {
        "name": "forward airbase",
        "assets": [
            {"id": "RWY", "name": "Runway", "type": "runway", "pos": (0, 0), "value": 100, "radius_m": 150},
            {"id": "HGR", "name": "Hangar line", "type": "hangar", "pos": (420, -300), "value": 80, "radius_m": 90},
            {"id": "FUEL", "name": "Fuel point", "type": "fuel", "pos": (-450, 260), "value": 70, "radius_m": 70},
        ],
    },
    {
        "name": "ammunition depot",
        "assets": [
            {"id": "DEPOT", "name": "Ammunition depot", "type": "depot", "pos": (0, 0), "value": 100, "radius_m": 160},
            {"id": "HQ", "name": "Brigade HQ", "type": "hq", "pos": (-500, 350), "value": 80, "radius_m": 80},
        ],
    },
    {
        "name": "radar and gun position",
        "assets": [
            {"id": "RADAR", "name": "Surveillance radar", "type": "radar", "pos": (0, 0), "value": 100, "radius_m": 70},
            {"id": "GUNS", "name": "Gun position", "type": "guns", "pos": (350, 250), "value": 70, "radius_m": 90},
            {"id": "LOG", "name": "Logistics park", "type": "logistics", "pos": (-400, -300), "value": 60, "radius_m": 110},
        ],
    },
]

SENSOR_SITE = [
    ("RDR", "d4_radar", (0, 40)),
    ("RFD", "rf_detector", (15, 40)),
    ("ACS", "acoustic_array", (-15, 40)),
    ("CAM", "eoir_turret", (0, 55)),
    ("IFF", "iff_interrogator", (0, 45)),
]

CRUISE = {c: load_catalogue().drones[c].cruise_mps for c in DroneClass}


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def procedural(seed: int, level: float, focus: Iterable[Skill | str] = (), mode: str = "procedural") -> Scenario:
    rng = random.Random(seed)
    level = _clamp(level, 0.0, 1.0)
    focus = [Skill(f) for f in focus]
    f = {s: (1.0 if s in focus else 0.0) for s in SKILLS}

    layout = rng.choice(LAYOUTS)
    terrain = "foothills" if rng.random() < 0.55 else "plains"

    # --- environment (S1, S3) ---------------------------------------------
    p_night = 0.12 + 0.6 * f[Skill.S3] + 0.25 * level
    r = rng.random()
    tod = TimeOfDay.night if r < p_night else TimeOfDay.dusk if r < p_night + 0.2 else TimeOfDay.day
    weather_w = {
        Weather.clear: 1.0,
        Weather.haze: 0.3 + 0.6 * f[Skill.S3] + 0.4 * level,
        Weather.rain: 0.15 + 0.5 * f[Skill.S3] + 0.3 * f[Skill.S1] + 0.3 * level,
        Weather.fog: 0.05 + 0.3 * f[Skill.S3] * level,
    }
    weather = rng.choices(list(weather_w), weights=list(weather_w.values()))[0]

    # --- town / no-fire zone, ROE (S6) --------------------------------------
    nfz = []
    town = None
    if level > 0.25 or f[Skill.S6] or rng.random() < 0.3:
        tb = rng.uniform(0, 360)
        tr = rng.uniform(2000, 3200)
        town = (round(math.sin(math.radians(tb)) * tr), round(math.cos(math.radians(tb)) * tr))
        nfz.append({"id": "TOWN", "name": "Town", "center": town, "radius_m": round(rng.uniform(600, 900))})
    if level < 0.25 and not f[Skill.S6]:
        roe = RoeState.weapons_free
    elif f[Skill.S6] and rng.random() < 0.5 + 0.3 * level:
        roe = RoeState.weapons_hold
    else:
        roe = RoeState.weapons_tight

    ambient = 45 + (10 if town else 0) + rng.uniform(-3, 5)

    # --- sensors and their failures (S8) -------------------------------------
    sensors = []
    degrade = f[Skill.S8] or (level > 0.5 and rng.random() < level - 0.3)
    for sid, stype, pos in SENSOR_SITE:
        events = []
        if degrade:
            if stype == "d4_radar" and rng.random() < 0.75:
                events.append(SensorEvent(t=round(rng.uniform(60, 180)), state="down", for_s=round(rng.uniform(35, 80))))
            if stype == "rf_detector" and rng.random() < 0.5:
                events.append(SensorEvent(t=round(rng.uniform(30, 150)), state="degraded", for_s=round(rng.uniform(60, 150))))
            if stype == "acoustic_array" and rng.random() < 0.4:
                events.append(SensorEvent(t=round(rng.uniform(30, 150)), state="degraded", for_s=round(rng.uniform(60, 150))))
        sensors.append(SensorPlacement(id=sid, type=stype, pos=pos, events=events))

    # --- effectors (S7 cost traps, scarcity with level) ----------------------
    eff = [
        EffectorPlacement(id="JAM", type="d4_rf_jammer", pos=(60, 20)),
        EffectorPlacement(id="GNS", type="d4_gnss_spoofer", pos=(60, 35)),
        EffectorPlacement(id="LSR", type="d4_laser", pos=(70, -30)),
        EffectorPlacement(id="RKT", type="bhargavastra_rocket", pos=(-120, 60), ammo=16 if level < 0.6 else 10),
        EffectorPlacement(id="MSL", type="bhargavastra_missile", pos=(-90, -80), ammo=4 if level < 0.6 else 2),
    ]
    gun = rng.choice(["zu23", "l70", "shilka"])
    eff.append(EffectorPlacement(id={"zu23": "ZU", "l70": "L70", "shilka": "SHK"}[gun], type=gun, pos=(260, 180)))
    if rng.random() < 0.4:
        eff.append(EffectorPlacement(id="ZU2", type="zu23", pos=(-300, -250)))
    if f[Skill.S7] or rng.random() < 0.4:
        eff.append(EffectorPlacement(id="SAM", type="sam_medium", pos=(-600, -500)))

    # --- threats (S4, S5, S7) ------------------------------------------------
    n_threats = round(3 + 13 * level + 8 * f[Skill.S5] + rng.uniform(-1, 2))
    rf_silent = _clamp(0.12 + 0.5 * f[Skill.S4] + 0.25 * level, 0, 0.9)
    lm_share = 0.1 + 0.15 * level
    decoy_share = 0.05 + 0.15 * level + 0.2 * f[Skill.S7]
    n_waves = max(1, min(5, 1 + int(level * 3) + (1 if f[Skill.S5] else 0) + rng.choice([0, 0, 1])))
    tactics = [Tactic.direct]
    if level >= 0.2:
        tactics += [Tactic.split_flank, Tactic.recon_then_strike]
    if level >= 0.35:
        tactics.append(Tactic.decoy_first)
    if level >= 0.45:
        tactics.append(Tactic.terrain_masked)
    if level >= 0.5 or f[Skill.S5]:
        tactics.append(Tactic.time_on_target)

    assets = layout["assets"]
    weights = [a["value"] for a in assets]
    per_wave = [0] * n_waves
    for i in range(n_threats):
        per_wave[i % n_waves] += 1
    waves = []
    used_bearings: list[float] = []
    t = rng.uniform(10, 30)
    for wi, n in enumerate(per_wave):
        tactic = rng.choice(tactics)
        # spread axes so waves don't stack on one bearing
        for _ in range(10):
            brg = rng.uniform(0, 360)
            if all(abs(((brg - b) + 180) % 360 - 180) > 50 for b in used_bearings):
                break
        if tactic == Tactic.terrain_masked and terrain == "foothills":
            brg = rng.uniform(320, 400) % 360  # come in low out of the hills to the north
        used_bearings.append(brg)
        units: dict[DroneClass, int] = {}

        def add(c: DroneClass, k: int = 1):
            units[c] = units.get(c, 0) + k

        if tactic == Tactic.recon_then_strike:
            add(DroneClass.recon_quad)
            n -= 1
        if tactic == Tactic.decoy_first:
            k = max(1, round(n * 0.4))
            add(DroneClass.decoy, k)
            add(DroneClass.loitering_munition)
            n -= k + 1
        for _ in range(max(0, n)):
            x = rng.random()
            if x < lm_share:
                add(DroneClass.loitering_munition)
            elif x < lm_share + decoy_share:
                add(DroneClass.decoy)
            elif rng.random() < rf_silent:
                add(DroneClass.fpv_fiber)
            else:
                add(DroneClass.fpv_rf)
        if not units:
            add(DroneClass.fpv_rf)
        target = rng.choices(assets, weights=weights)[0]["id"]
        rng_m = rng.uniform(5500, 7500)
        arrival = None
        if tactic == Tactic.time_on_target:
            slowest = min(CRUISE[c] for c in units)
            arrival = round((rng_m + 1500) / slowest + 20)
        waves.append(Wave(
            id=f"W{wi + 1}", t=round(t, 1), tactic=tactic, bearing_deg=round(brg % 360, 1),
            spread_deg=round(rng.uniform(10, 30), 1), range_m=round(rng_m), target=target,
            units=[WaveUnit(cls=c, n=k) for c, k in units.items()], arrival_s=arrival,
        ))
        t += rng.uniform(35, 90) * (0.6 if f[Skill.S5] else 1.0)

    # independent recon probe now and then (cost-exchange bait)
    if f[Skill.S7] or rng.random() < 0.35:
        waves.append(Wave(
            id=f"W{len(waves) + 1}", t=round(rng.uniform(5, 60), 1), tactic=Tactic.direct,
            bearing_deg=round(rng.uniform(0, 360), 1), spread_deg=10, range_m=round(rng.uniform(4000, 5000)),
            target=assets[0]["id"], units=[WaveUnit(cls=DroneClass.recon_quad, n=1 + int(f[Skill.S7]))],
        ))

    # --- clutter (S1, S6) ----------------------------------------------------
    corridors = []
    flights = []
    if f[Skill.S6] or rng.random() < 0.55:
        for k in range(1 + int(f[Skill.S6] and rng.random() < 0.6)):
            cb = rng.uniform(0, 360)
            a = (math.sin(math.radians(cb)) * 4500, math.cos(math.radians(cb)) * 4500)
            b2 = cb + rng.choice([-1, 1]) * rng.uniform(35, 60)
            b = (math.sin(math.radians(b2)) * 3500, math.cos(math.radians(b2)) * 3500)
            cid = ["ALPHA", "BRAVO"][k]
            corridors.append({"id": cid, "name": f"Corridor {cid}", "points": [tuple(map(round, a)), tuple(map(round, b))],
                              "alt_m": round(rng.uniform(380, 520))})
            flights.append(FriendlyFlight(id=f"F{k + 1}", corridor=cid, t=round(rng.uniform(0, 30)),
                                          iff=not (k == 1 and level > 0.55)))
    clutter = Clutter(
        bird_flocks=round(1 + 3 * f[Skill.S1] + 2 * level + rng.uniform(-0.5, 1)),
        birds_per_flock=(3, 6 + int(3 * f[Skill.S1])),
        friendly_flights=flights,
        civil_drones=(rng.randint(1, 3) if town and (f[Skill.S6] or rng.random() < 0.3) else 0),
    )

    duration = _duration(waves)
    focus_txt = ", ".join(SKILL_NAMES[s] for s in focus) or "general"
    sc = Scenario(
        id=f"gen-{seed}",
        name=f"Generated: {layout['name']} ({tod.value}, {weather.value})",
        seed=seed,
        mode=mode,
        briefing=(
            f"Defend a {layout['name']} on the {terrain}. Time: {tod.value}; weather: {weather.value}. "
            f"ROE: {roe.value.replace('_', ' ')}. "
            + (f"A friendly UAV is up on {', '.join(c['name'] for c in corridors)}. " if corridors else "")
            + ("A town lies inside the defended area: it is a no-fire zone. " if town else "")
        ),
        intel=_intel(waves, rf_silent, rng, level),
        duration_s=duration,
        map=MapSpec(terrain_seed=rng.randint(1, 10_000), terrain=terrain, assets=assets, no_fire_zones=nfz, corridors=corridors),
        environment=Environment(time_of_day=tod, weather=weather, ambient_noise_db=round(ambient, 1)),
        roe=Roe(state=roe, authority_delay_s=8),
        sensors=sensors,
        effectors=eff,
        waves=waves,
        clutter=clutter,
        tags=[mode, tod.value, weather.value] + [s.value for s in focus],
    )
    sc.difficulty.level = round(level, 3)
    sc.difficulty.focus = focus
    sc.difficulty.load = skill_load(sc)
    sc.fingerprint = fingerprint(sc)
    return sc


def _duration(waves: list[Wave]) -> float:
    end = 0.0
    for w in waves:
        slow = min(CRUISE[u.cls] for u in w.units)
        extra = 40 if w.tactic == Tactic.decoy_first else 80 if w.tactic == Tactic.recon_then_strike else 0
        detour = 2500 if w.tactic == Tactic.split_flank else 0
        travel = (w.arrival_s or (w.range_m + detour) / slow)
        if any(u.cls == DroneClass.recon_quad for u in w.units):
            travel = max(travel, (w.range_m - 2000) / CRUISE[DroneClass.recon_quad] + 80)
        end = max(end, w.t + extra + travel)
    return float(round(_clamp(end + 45, 240, 720)))


def _intel(waves: list[Wave], rf_silent: float, rng: random.Random, level: float) -> str:
    axes = sorted({_compass(w.bearing_deg) for w in waves})
    lines = [f"Likely approach from the {', '.join(axes)}."]
    if rf_silent > 0.4:
        lines.append("Expect RF-silent attackers (fiber-optic or pre-programmed).")
    if any(u.cls == DroneClass.decoy for w in waves for u in w.units):
        lines.append("Decoys may precede the real strike.")
    if level > 0.7 and rng.random() < 0.3:
        lines.append("Intelligence confidence is LOW.")
    return " ".join(lines)


def _compass(brg: float) -> str:
    names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]
    return names[int(((brg % 360) + 22.5) // 45) % 8]


# ---------------------------------------------------------------------------
# difficulty load and fingerprints
# ---------------------------------------------------------------------------

def skill_load(sc: Scenario) -> dict[Skill, float]:
    """How hard this mission is on each skill, 0..1 (feeds the Elo update)."""
    units = [(u.cls, u.n) for w in sc.waves for u in w.units]
    n_hostile = sum(n for _, n in units)
    silent = sum(n for c, n in units if c in (DroneClass.fpv_fiber, DroneClass.loitering_munition, DroneClass.decoy))
    birds = sc.clutter.bird_flocks * sum(sc.clutter.birds_per_flock) / 2
    night = sc.environment.time_of_day != TimeOfDay.day
    bad_wx = sc.environment.weather != Weather.clear
    peak = max((sum(u.n for u in w.units) for w in sc.waves), default=0)
    tot = sum(1 for w in sc.waves if w.tactic in (Tactic.time_on_target, Tactic.split_flank, Tactic.decoy_first))
    degraded = sum(len(s.events) for s in sc.sensors)
    has_sam = any(e.type == "sam_medium" for e in sc.effectors)
    cheap = sum(n for c, n in units if c in (DroneClass.recon_quad, DroneClass.decoy, DroneClass.fpv_rf))
    load = {
        Skill.S1: _clamp(birds / 25 + (0.2 if sc.environment.weather == Weather.rain else 0), 0, 1),
        Skill.S2: _clamp((0.0 if night else 0.4) + 0.04 * n_hostile + 0.02 * birds, 0, 1) if not night else 0.0,
        Skill.S3: _clamp((0.55 if sc.environment.time_of_day == TimeOfDay.night else 0.3 if night else 0) + (0.3 if bad_wx else 0) + 0.02 * n_hostile, 0, 1),
        Skill.S4: _clamp(silent / max(1, n_hostile) + 0.02 * silent, 0, 1),
        Skill.S5: _clamp(0.04 * n_hostile + 0.05 * peak + 0.1 * tot, 0, 1),
        Skill.S6: _clamp(0.25 * len(sc.clutter.friendly_flights) + 0.15 * sc.clutter.civil_drones + 0.2 * len(sc.map.no_fire_zones)
                         + {RoeState.weapons_free: 0, RoeState.weapons_tight: 0.15, RoeState.weapons_hold: 0.35}[sc.roe.state], 0, 1),
        Skill.S7: _clamp((0.35 if has_sam else 0) + 0.04 * cheap, 0, 1),
        Skill.S8: _clamp(0.3 * degraded, 0, 1),
    }
    return {k: round(v, 3) for k, v in load.items()}


def fingerprint(sc: Scenario) -> str:
    """Coarse identity used to stop a trainee getting near-repeats (PLAN.md 6.2)."""
    key = {
        "terrain": sc.map.terrain,
        "assets": [a.id for a in sc.map.assets],
        "tod": sc.environment.time_of_day,
        "wx": sc.environment.weather,
        "roe": sc.roe.state,
        "waves": sorted((w.tactic.value, int(w.bearing_deg // 45), tuple(sorted((u.cls.value, u.n) for u in w.units))) for w in sc.waves),
    }
    return hashlib.sha1(json.dumps(key, sort_keys=True, default=str).encode()).hexdigest()[:12]


def fresh_procedural(level: float, focus: Iterable[Skill | str], recent_fingerprints: set[str], rng: random.Random) -> Scenario:
    """A procedural mission whose fingerprint the trainee hasn't flown recently."""
    for _ in range(25):
        sc = procedural(rng.randint(1, 2**31 - 1), level, focus)
        if sc.fingerprint not in recent_fingerprints:
            return sc
    return sc


def dump_batch(out_dir: Path, n: int, seed0: int = 1) -> list[Path]:
    """Write n procedural scenarios (spread over levels and focuses) for headless bot runs."""
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    rng = random.Random(seed0)
    for i in range(n):
        level = (i % 10) / 9
        focus = rng.sample(SKILLS, k=rng.choice([0, 1, 2]))
        sc = procedural(seed0 + i, level, focus)
        p = out_dir / f"{sc.id}.json"
        p.write_text(sc.model_dump_json())
        paths.append(p)
    return paths
