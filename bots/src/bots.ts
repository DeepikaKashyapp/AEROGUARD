/**
 * Headless players on the same sim core (PLAN.md 6.15).
 *
 *  - oracle: sees ground truth, hooks at t0, classifies correctly, picks the
 *    cheapest effective effector the ROE allows, by time-to-impact. Gives the
 *    best achievable score (score normalisation, generator solvability).
 *  - baselines: deliberately bad habits, each built to trip specific scoring
 *    rules (the scorer's regression suite).
 *  - trainee: a noisy oracle with a skill per S1..S8: synthetic learners for
 *    the dashboards and for testing the adaptive engine. Never presented as
 *    real data.
 */
import { Rng, streamSeed, type DroneClass, type EffectorState, type Entity, type Label, type Sim, type Track } from "@cuas/sim";
import { angleDiff, bearing, dist } from "@cuas/sim";

export interface Bot {
  name: string;
  /** Called every tick; bots throttle themselves. */
  act(sim: Sim): void;
}

const LABEL_OF: Record<DroneClass, Label> = {
  bird: "bird",
  friendly_uav: "friendly",
  civil_drone: "civil",
  recon_quad: "recon",
  fpv_rf: "fpv",
  fpv_fiber: "fpv",
  loitering_munition: "loitering",
  decoy: "decoy",
};

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

export function truthOf(sim: Sim, tr: Track): Entity {
  return sim.byId.get(tr.entityId)!;
}

export function liveTracks(sim: Sim): Track[] {
  return sim.tracks.filter((t) => t.displayed && !t.down);
}

export function busy(sim: Sim, tr: Track): boolean {
  return sim.effectors.some((f) => f.targetTrack === tr.id && (f.status === "active" || f.status === "slewing"));
}

export function canUse(sim: Sim, f: EffectorState, tr: Track): boolean {
  if (!sim.effectorReady(f.id)) return false;
  if (f.ammo !== null && f.ammo < f.spec.rounds_per_shot) return false;
  const p = sim.predicted(tr);
  if (dist(f.pos, p) > f.spec.range_m * 0.97) return false;
  if (f.spec.needs_los && !sim.terrain.los(f.pos, p)) return false;
  if (f.spec.kind === "laser" && !sim.weatherFx().laser_ok) return false;
  return true;
}

/** Would a jam/spoof sector aimed at this track catch a friendly or civil drone? */
export function sectorHitsFriendly(sim: Sim, f: EffectorState, tr: Track): boolean {
  const brg = bearing(f.pos, sim.predicted(tr));
  return sim.entities.some(
    (e) =>
      e.flying &&
      !e.spec.hostile &&
      e.cls !== "bird" &&
      dist(f.pos, e.pos) <= f.spec.range_m &&
      Math.abs(angleDiff(bearing(f.pos, e.pos), brg)) <= f.spec.sector_half_deg + 2,
  );
}

const byTti = (sim: Sim) => (a: Track, b: Track) => (sim.tti(a) ?? 1e9) - (sim.tti(b) ?? 1e9);

/** Preferred effector kinds per class, cheapest effective first. */
const PREFERENCE: Partial<Record<DroneClass, string[]>> = {
  recon_quad: ["rf_jam", "laser", "gun", "rocket"],
  fpv_rf: ["rf_jam", "laser", "gun", "rocket", "missile"],
  fpv_fiber: ["laser", "gun", "rocket", "missile"],
  loitering_munition: ["laser", "gun", "rocket", "missile"],
};

/** Guns and rockets lose most of their Pk near maximum range; good operators wait. */
const EFFECTIVE_RANGE: Partial<Record<string, number>> = { gun: 0.7, rocket: 0.9 };

function pickEffector(
  sim: Sim,
  tr: Track,
  kinds: string[],
  opts: { avoidNfz: boolean; avoidFriendlySector: boolean; patient?: boolean; maxShotCost?: number },
): EffectorState | null {
  const overNfz = sim.inNoFireZone(sim.predicted(tr));
  const p = sim.predicted(tr);
  for (const kind of kinds) {
    const options = sim.effectors
      .filter((f) => f.spec.kind === kind && canUse(sim, f, tr))
      .filter((f) => opts.maxShotCost === undefined || f.spec.cost_inr * f.spec.rounds_per_shot <= opts.maxShotCost)
      .filter((f) => !opts.patient || dist(f.pos, p) <= f.spec.range_m * (EFFECTIVE_RANGE[kind] ?? 1))
      .filter((f) => !(opts.avoidNfz && overNfz && (f.spec.kind === "gun" || f.spec.kind === "rocket")))
      .filter((f) => !(opts.avoidFriendlySector && f.spec.kill === "soft" && sectorHitsFriendly(sim, f, tr)))
      .sort((a, b) => a.spec.cost_inr * a.spec.rounds_per_shot - b.spec.cost_inr * b.spec.rounds_per_shot);
    if (options.length) return options[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// oracle
// ---------------------------------------------------------------------------

export class Oracle implements Bot {
  name = "oracle";
  private next = 0;
  private tried = new Map<string, Set<string>>();

  act(sim: Sim): void {
    if (sim.t < this.next) return;
    this.next = sim.t + 0.25;
    for (const tr of liveTracks(sim).sort(byTti(sim))) {
      const e = truthOf(sim, tr);
      sim.hook(tr.id);
      const label = LABEL_OF[e.cls];
      if (tr.label !== label) sim.classify(tr.id, label);
      if (!e.spec.hostile || e.cls === "decoy") {
        if (tr.decision === "none") sim.decide(tr.id, e.cls === "bird" ? "ignore" : "monitor");
        continue;
      }
      if (e.outcome !== "active" || busy(sim, tr)) continue;
      if (sim.roe === "weapons_hold" && tr.authority !== "granted") {
        sim.requestAuthority(tr.id);
        continue;
      }
      // soft kill already tried and failed on this track? go hard
      const tried = this.tried.get(tr.id) ?? new Set<string>();
      const kinds = (PREFERENCE[e.cls] ?? ["laser", "gun", "rocket", "missile"]).filter((k) => !tried.has(k) || k !== "rf_jam");
      const urgent = (sim.tti(tr) ?? 1e9) < 25;
      // cost-exchange: nothing costing more than 5x the drone unless it is about to hit
      const f = pickEffector(sim, tr, kinds, { avoidNfz: true, avoidFriendlySector: true, patient: !urgent, maxShotCost: urgent ? undefined : e.spec.cost_inr * 5 });
      if (!f) continue;
      if (sim.engage(tr.id, f.id).ok) {
        tried.add(f.spec.kind);
        this.tried.set(tr.id, tried);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// baselines (each built to trip specific rules)
// ---------------------------------------------------------------------------

/** Hooks and labels everything perfectly but never fires: leakers. */
export class Passive implements Bot {
  name = "passive";
  act(sim: Sim): void {
    if (sim.tick % 5) return;
    for (const tr of liveTracks(sim)) {
      sim.hook(tr.id);
      const label = LABEL_OF[truthOf(sim, tr).cls];
      if (tr.label !== label) sim.classify(tr.id, label);
    }
  }
}

/** Fires the most expensive effector at every track, unclassified: cost-exchange, ROE, fratricide. */
export class MissileEverything implements Bot {
  name = "missile_everything";
  act(sim: Sim): void {
    if (sim.tick % 5) return;
    for (const tr of liveTracks(sim).sort(byTti(sim))) {
      sim.hook(tr.id);
      if (busy(sim, tr)) continue;
      const f = sim.effectors
        .filter((x) => (x.spec.kind === "sam" || x.spec.kind === "missile") && canUse(sim, x, tr))
        .sort((a, b) => b.spec.cost_inr - a.spec.cost_inr)[0];
      if (f) sim.engage(tr.id, f.id);
    }
  }
}

/** Labels correctly, then jams everything hostile, fiber and pre-programmed included. */
export class JamEverything implements Bot {
  name = "jam_everything";
  act(sim: Sim): void {
    if (sim.tick % 5) return;
    for (const tr of liveTracks(sim).sort(byTti(sim))) {
      const e = truthOf(sim, tr);
      sim.hook(tr.id);
      const label = LABEL_OF[e.cls];
      if (tr.label !== label) sim.classify(tr.id, label);
      if (!e.spec.hostile || busy(sim, tr)) continue;
      const f = sim.effectors.find((x) => x.spec.kind === "rf_jam" && canUse(sim, x, tr));
      if (f) sim.engage(tr.id, f.id);
    }
  }
}

/** Calls everything an FPV and guns it: false alarms, fratricide, collateral. */
export class TriggerHappy implements Bot {
  name = "trigger_happy";
  act(sim: Sim): void {
    if (sim.tick % 5) return;
    for (const tr of liveTracks(sim).sort(byTti(sim))) {
      if (tr.label !== "fpv") sim.classify(tr.id, "fpv");
      if (busy(sim, tr)) continue;
      const f = sim.effectors.find((x) => x.spec.kind === "gun" && canUse(sim, x, tr));
      if (f) sim.engage(tr.id, f.id);
    }
  }
}

// ---------------------------------------------------------------------------
// synthetic trainee (noisy oracle with per-skill ability)
// ---------------------------------------------------------------------------

export type SkillProfile = Record<"S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8", number>;

const CONFUSIONS: Record<Label, Label[]> = {
  bird: ["recon", "fpv", "unknown"],
  friendly: ["unknown", "recon", "loitering"],
  civil: ["recon", "fpv", "unknown"],
  recon: ["bird", "civil", "fpv"],
  fpv: ["bird", "recon", "unknown"],
  loitering: ["decoy", "unknown"],
  decoy: ["loitering", "unknown"],
  unknown: ["unknown"],
};

export class SyntheticTrainee implements Bot {
  name = "synthetic_trainee";
  private rng: Rng;
  private next = 0;
  private seenAt = new Map<string, number>();
  private plan = new Map<string, { hookAt: number; decideAt: number; label: Label }>();
  private tried = new Map<string, Set<string>>();

  readonly skill: SkillProfile;

  constructor(skill: SkillProfile, seed: number) {
    this.skill = skill;
    this.rng = new Rng(streamSeed(seed, "synthetic-trainee"));
  }

  act(sim: Sim): void {
    if (sim.t < this.next) return;
    this.next = sim.t + 0.5;
    const s = this.skill;
    const night = sim.sc.environment.time_of_day !== "day" || sim.sc.environment.weather !== "clear";
    const degraded = sim.sensors.some((x) => x.status !== "ok");
    const live = liveTracks(sim).sort(byTti(sim));
    const load = live.length;
    // saturation: an unskilled operator only works a few tracks at a time
    const capacity = Math.round(3 + 12 * s.S5);
    let worked = 0;
    for (const tr of live) {
      const e = truthOf(sim, tr);
      if (!this.seenAt.has(tr.id)) this.seenAt.set(tr.id, sim.t);
      let p = this.plan.get(tr.id);
      if (!p) {
        const base = 1.5 + 18 * (1 - s.S1) * (e.cls === "bird" ? 1.3 : 1);
        const slow = (load > 6 ? 1 + (1 - s.S5) * (load - 6) * 0.25 : 1) * (degraded ? 1 + (1 - s.S8) : 1);
        const hookAt = sim.t + this.rng.range(0.5, 1.5) * base * slow;
        const truth = LABEL_OF[e.cls];
        const acc = 0.55 + 0.43 * (night ? s.S3 : s.S2);
        let label = truth;
        if (!this.rng.chance(acc)) label = this.rng.pick(CONFUSIONS[truth]);
        if (e.cls === "friendly_uav" && tr.iff === "friend" && this.rng.chance(0.5 + 0.5 * s.S6)) label = "friendly";
        p = { hookAt, decideAt: hookAt + this.rng.range(1, 3) + 10 * (1 - s.S5), label };
        this.plan.set(tr.id, p);
      }
      if (sim.t < p.hookAt) continue;
      if (worked >= capacity) continue;
      worked += 1;
      sim.hook(tr.id);
      if (tr.label !== p.label) sim.classify(tr.id, p.label);
      if (sim.t < p.decideAt || busy(sim, tr)) continue;
      this.decide(sim, tr, e, p.label);
    }
  }

  private styles = new Map<string, { linkAware: boolean; disciplined: boolean; careful: boolean; asksAuthority: boolean; letsDecoysGo: boolean; holdsUnknown: boolean }>();

  /** How this operator will handle this track, rolled once (not every tick). */
  private styleFor(tr: Track) {
    let st = this.styles.get(tr.id);
    if (!st) {
      const s = this.skill;
      st = {
        linkAware: this.rng.chance(0.2 + 0.8 * s.S4),
        disciplined: this.rng.chance(0.3 + 0.7 * s.S7),
        careful: this.rng.chance(0.3 + 0.7 * s.S6),
        asksAuthority: this.rng.chance(0.3 + 0.7 * s.S6),
        letsDecoysGo: this.rng.chance(s.S7),
        holdsUnknown: this.rng.chance(s.S6),
      };
      this.styles.set(tr.id, st);
    }
    return st;
  }

  private decide(sim: Sim, tr: Track, e: Entity, label: Label): void {
    const s = this.skill;
    const st = this.styleFor(tr);
    const thinksHostile = label === "fpv" || label === "recon" || label === "loitering" || label === "decoy" || label === "unknown";
    if (!thinksHostile) {
      if (tr.decision === "none") sim.decide(tr.id, label === "bird" ? "ignore" : "monitor");
      return;
    }
    if (label === "decoy" && st.letsDecoysGo) {
      if (tr.decision === "none") sim.decide(tr.id, "monitor");
      return;
    }
    if (label === "unknown" && sim.roe === "weapons_tight" && st.holdsUnknown) {
      if (tr.decision === "none") sim.decide(tr.id, "monitor");
      return;
    }
    if (sim.roe === "weapons_hold" && tr.authority !== "granted" && st.asksAuthority) {
      sim.requestAuthority(tr.id);
      return;
    }
    if (e.outcome !== "active" && this.rng.chance(s.S4)) return; // already diverted/jammed: a good operator stops
    const tried = this.tried.get(tr.id) ?? new Set<string>();
    // Does the operator reason about the control link? (S4)
    const linkAware = st.linkAware;
    const rfQuiet = !tr.rfBand;
    let kinds: string[];
    if (label === "fpv" || label === "recon") kinds = linkAware && rfQuiet ? ["laser", "gun", "rocket", "missile"] : ["rf_jam", "laser", "gun", "rocket", "missile"];
    else if (label === "loitering" || label === "decoy") kinds = linkAware ? ["laser", "gun", "rocket", "missile", "sam"] : ["rf_jam", "gnss_spoof", "laser", "missile", "sam"];
    else kinds = ["laser", "gun", "rocket", "missile"];
    // cost discipline (S7): the undisciplined reach for the big stick
    if (!st.disciplined) kinds = ["sam", "missile", ...kinds];
    kinds = kinds.filter((k) => !(k === "rf_jam" && tried.has("rf_jam")));
    const f = pickEffector(sim, tr, kinds, { avoidNfz: st.careful, avoidFriendlySector: st.careful, patient: st.disciplined && (sim.tti(tr) ?? 1e9) > 25 });
    if (f && sim.engage(tr.id, f.id).ok) {
      tried.add(f.spec.kind);
      this.tried.set(tr.id, tried);
    }
  }
}

export function makeBot(name: string, opts: { skill?: SkillProfile; seed?: number } = {}): Bot {
  switch (name) {
    case "oracle":
      return new Oracle();
    case "passive":
      return new Passive();
    case "missile_everything":
      return new MissileEverything();
    case "jam_everything":
      return new JamEverything();
    case "trigger_happy":
      return new TriggerHappy();
    case "synthetic_trainee":
      return new SyntheticTrainee(opts.skill ?? flatSkill(0.5), opts.seed ?? 1);
    default:
      throw new Error(`unknown bot ${name}`);
  }
}

export function flatSkill(x: number): SkillProfile {
  return { S1: x, S2: x, S3: x, S4: x, S5: x, S6: x, S7: x, S8: x };
}

/** Play a whole mission headless. */
export function play(sim: Sim, bot: Bot): void {
  while (!sim.ended) {
    bot.act(sim);
    sim.step();
  }
}
