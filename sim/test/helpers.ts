import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Catalogue, DroneClass, Scenario } from "../src/contracts.ts";
import { Sim, type SimOptions } from "../src/sim.ts";
import { makeEntity } from "../src/spawn.ts";
import type { Entity, Role } from "../src/types.ts";
import { v3, type Vec3 } from "../src/vec.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const catalogue: Catalogue = JSON.parse(readFileSync(here("../../schemas/catalogue.json"), "utf8"));

export function fixture(): Scenario {
  return JSON.parse(readFileSync(here("./fixtures/basic.json"), "utf8"));
}

/** The fixture with no waves and no clutter: an empty sky to stage situations in. */
export function emptySky(patch: Partial<Scenario> = {}): Scenario {
  const sc = fixture();
  sc.waves = [];
  sc.clutter = { bird_flocks: 0, birds_per_flock: [3, 5], friendly_flights: [], civil_drones: 0 };
  sc.map.terrain = "plains";
  sc.duration_s = 600;
  return { ...sc, ...patch };
}

export function makeSim(sc: Scenario, opts: Partial<SimOptions> = {}): Sim {
  return new Sim({ scenario: sc, catalogue, actor: "bot", bot: "test", ...opts });
}

/**
 * Put an entity into the world right now. `toward` gives it a strike route to
 * that point; otherwise it holds the given velocity (role "bird" style drift
 * is avoided by giving it role "strike" with a far aim).
 */
export function inject(
  sim: Sim,
  cls: DroneClass,
  pos: Vec3,
  opts: { toward?: Vec3; role?: Role; speed?: number; agl?: number } = {},
): Entity {
  const e = makeEntity(catalogue, cls, opts.role ?? (cls === "friendly_uav" ? "patrol" : "strike"), v3(pos.x, pos.y, 0), sim.t, sim.rng.spawn);
  e.agl = opts.agl ?? 60;
  e.pos.z = sim.terrain.height(pos.x, pos.y) + e.agl;
  e.idx = sim.entities.length;
  e.id = `X${String(e.idx + 1).padStart(3, "0")}`;
  if (opts.speed !== undefined) e.speed = opts.speed;
  const aim = opts.toward ?? v3(0, 0, 0);
  e.aim = v3(aim.x, aim.y, 0);
  e.route = [{ x: aim.x, y: aim.y, agl: e.agl }];
  if (e.role === "patrol") {
    e.patrolPts = [v3(pos.x, pos.y, e.pos.z), v3(aim.x, aim.y, e.pos.z)];
    e.wp = 1;
  }
  sim.entities.push(e);
  sim.byId.set(e.id, e);
  return e;
}

/** Step until `pred` is true or `maxS` seconds pass. Returns whether it became true. */
export function until(sim: Sim, pred: () => boolean, maxS = 120): boolean {
  const stop = sim.t + maxS;
  while (sim.t < stop && !sim.ended) {
    sim.step();
    if (pred()) return true;
  }
  return pred();
}

export function trackOf(sim: Sim, e: Entity) {
  return sim.trackByEntity.get(e.id);
}
