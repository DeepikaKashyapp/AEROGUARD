/**
 * The simulation core (PLAN.md 6.3): a deterministic, fixed-timestep world
 * that runs identically in the browser (trainee) and in Node (bots).
 *
 * Ground truth (entities) never reaches the C2 display. The UI gets `view()`,
 * built only from tracks: what the sensors produced and what the trainee
 * decided. The EO/IR camera renders `renderables()`, which is truth shown as
 * pixels, just like a real camera.
 *
 * Everything the trainee does goes into an append-only event log; `result()`
 * returns that log plus the ground-truth manifest and replay frames for the
 * server to score (PLAN.md 5.5).
 */
import type {
  Catalogue,
  EventType,
  Label,
  RoeState,
  Scenario,
  SensorSpec,
  SessionResult,
  SimEvent,
  TruthEntity,
  Outcome,
  WeatherEffect,
} from "./contracts.ts";
import { onDiverted, onLinkLost, updateEntity, type BehaviourWorld } from "./behaviour.ts";
import { cease as doCease, engage as doEngage, effectorReady, runEffectors } from "./effectors.ts";
import { ReplayRecorder } from "./replay.ts";
import { streams, type Streams } from "./rng.ts";
import { cameraCanSee, clampFov, runSensors, updateSensorStatus } from "./sensors.ts";
import { planSpawns, type SpawnPlan } from "./spawn.ts";
import { Terrain } from "./terrain.ts";
import type {
  AidSuggestion,
  CameraState,
  CommandResult,
  Decision,
  EffectorState,
  EffectorView,
  Entity,
  FeedItem,
  Hostility,
  Projectile,
  Renderable,
  SensorState,
  ShotView,
  SimView,
  Strobe,
  Track,
  TrackView,
} from "./types.ts";
import {
  add,
  angleDiff,
  bearing,
  clamp,
  DEG,
  dist2,
  dot,
  elevation,
  len2,
  norm,
  polar,
  scale,
  sub,
  v3,
  type Vec3,
} from "./vec.ts";

export const DT = 0.05;
const COAST_S = 6;
const SPLASH_S = 6;
const LOST_SHOWN_S = 20;

export const LABELS: Label[] = ["unknown", "bird", "friendly", "civil", "recon", "fpv", "loitering", "decoy"];
export const DECISIONS: Decision[] = ["none", "ignore", "monitor", "engage"];

export function hostilityOf(label: Label): Hostility {
  if (label === "unknown") return "unknown";
  if (label === "friendly") return "friend";
  if (label === "bird" || label === "civil") return "neutral";
  return "hostile";
}

export type AidFn = (sim: Sim, tr: Track) => AidSuggestion | null;

export interface SimOptions {
  scenario: Scenario;
  catalogue: Catalogue;
  actor?: "trainee" | "bot";
  bot?: string;
  record?: boolean;
  aidMode?: "off" | "honest" | "unreliable";
  aid?: AidFn;
}

interface Shot {
  kind: ShotView["kind"];
  from: Vec3;
  to: Vec3;
  t: number;
}

export class Sim {
  readonly sc: Scenario;
  readonly cat: Catalogue;
  readonly dt = DT;
  readonly terrain: Terrain;
  readonly rng: Streams;
  readonly actor: "trainee" | "bot";
  readonly bot: string | null;
  readonly aidMode: "off" | "honest" | "unreliable";

  t = 0;
  tick = 0;
  ended = false;
  endReason: SessionResult["ended_reason"] | null = null;
  paused = false;

  entities: Entity[] = [];
  byId = new Map<string, Entity>();
  tracks: Track[] = [];
  trackById = new Map<string, Track>();
  trackByEntity = new Map<string, Track>();
  sensors: SensorState[];
  effectors: EffectorState[];
  projectiles: Projectile[] = [];
  strobes = new Map<string, Strobe>();
  camera: CameraState;
  events: SimEvent[] = [];
  feed: FeedItem[] = [];
  assetHealth = new Map<string, number>();
  spend = 0;
  roe: RoeState;
  orderSeq = 0;
  orderSpent = new Map<number, number>();

  private shots = new Map<string, Shot>();
  private shotSeq = 0;
  private pending: SpawnPlan[];
  private groups = new Map<string, Entity[]>();
  private flocks: { center: Vec3; target: Vec3 }[] = [];
  private nextTrackNum = 1;
  private lastCamLog = -1;
  private lastCamFix = -1;
  private lastAid = -1;
  private resolvedAt: number | null = null;
  private recorder: ReplayRecorder | null;
  private world: BehaviourWorld;
  private authorityQueue: { track: string; at: number }[] = [];
  private aidFn: AidFn | null;

  constructor(opts: SimOptions) {
    const sc = opts.scenario;
    this.sc = sc;
    this.cat = opts.catalogue;
    this.actor = opts.actor ?? "trainee";
    this.bot = opts.bot ?? null;
    this.aidMode = opts.aidMode ?? "off";
    this.aidFn = opts.aid ?? null;
    this.rng = streams(sc.seed);
    this.roe = sc.roe.state;
    this.terrain = new Terrain(
      sc.map.terrain_seed,
      sc.map.terrain,
      sc.map.size_m,
      sc.map.assets.map((a) => ({ x: a.pos[0], y: a.pos[1], r: Math.max(500, a.radius_m * 4) })),
    );
    this.pending = planSpawns(sc, this.cat, this.terrain, this.rng.spawn, this.rng.birds);
    for (const p of this.pending) {
      if (p.entity.cls === "bird" && p.entity.flockId >= this.flocks.length) {
        const c = p.entity.orbitCenter!;
        this.flocks.push({ center: v3(c.x, c.y, 0), target: polar(v3(), this.rng.birds.range(0, 360), this.rng.birds.range(800, 5500)) });
      }
    }
    this.sensors = sc.sensors.map((s, idx) => {
      const spec = this.cat.sensors[s.type];
      if (!spec) throw new Error(`unknown sensor type ${s.type}`);
      return {
        id: s.id,
        idx,
        type: spec.type,
        spec,
        pos: v3(s.pos[0], s.pos[1], this.terrain.height(s.pos[0], s.pos[1]) + (spec.params.mast_m ?? 6)),
        status: "ok",
        nextUpdate: 0,
      };
    });
    this.effectors = sc.effectors.map((f, idx) => {
      const spec = this.cat.effectors[f.type];
      if (!spec) throw new Error(`unknown effector type ${f.type}`);
      return {
        id: f.id,
        idx,
        type: f.type,
        spec,
        pos: v3(f.pos[0], f.pos[1], this.terrain.height(f.pos[0], f.pos[1]) + 4),
        ammo: f.ammo ?? spec.ammo ?? null,
        status: "ready",
        orderId: 0,
        targetTrack: null,
        targetEntity: null,
        bearing: 0,
        until: 0,
        readyAt: 0,
        nextShotT: 0,
        dwell: 0,
        outOfRangeSince: null,
        affected: new Set(),
        exposure: new Map(),
        rolled: new Set(),
        collateralLogged: false,
      };
    });
    for (const a of sc.map.assets) this.assetHealth.set(a.id, 100);
    this.camera = { az: 0, el: 2, fov: 30, mode: "eo", targetAz: 0, targetEl: 2, cueTrack: null, lockEntity: null, lockTrack: null };
    this.recorder = opts.record === false ? null : new ReplayRecorder();
    this.world = this.makeWorld();
    this.emit("session_start", {
      data: {
        scenario: sc.id,
        seed: sc.seed,
        roe: sc.roe.state,
        time_of_day: sc.environment.time_of_day,
        weather: sc.environment.weather,
        aid_mode: this.aidMode,
      },
    });
    this.say(`MISSION START · ROE ${this.roe.replace("_", " ").toUpperCase()}`, "info");
  }

  // ------------------------------------------------------------------------
  // main loop
  // ------------------------------------------------------------------------

  step(): void {
    if (this.ended) return;
    this.tick += 1;
    this.t = Math.round(this.tick * DT * 1000) / 1000;
    this.spawnDue();
    updateSensorStatus(this);
    this.updateFlocks();
    for (const e of this.entities) if (e.flying) updateEntity(e, this.world);
    runEffectors(this);
    runSensors(this);
    this.updateCamera();
    this.updateTracks();
    this.processAuthority();
    this.runAid();
    this.logCamera();
    for (const [k, s] of this.shots) if (this.t - s.t > 0.5) this.shots.delete(k);
    this.recorder?.maybeRecord(this);
    this.checkEnd();
  }

  /** Advance by `seconds` of sim time (used by bots and tests). */
  advance(seconds: number): void {
    const until = this.t + seconds;
    while (!this.ended && this.t < until - 1e-9) this.step();
  }

  private spawnDue(): void {
    while (this.pending.length && this.pending[0].t <= this.t) {
      const p = this.pending.shift()!;
      const e = p.entity;
      if (p.dependsOnRecon && e.aim) {
        const recon = this.groups.get(p.dependsOnRecon) ?? [];
        const scouted = recon.some((r) => r.reconDone || (r.flying && !r.linkLost && !r.diverted));
        if (!scouted) {
          // every recon was dealt with before the strike launched: it flies on stale coordinates
          e.aim = v3(e.aim.x + this.rng.spawn.gauss() * 230, e.aim.y + this.rng.spawn.gauss() * 230, 0);
          e.route[e.route.length - 1] = { x: e.aim.x, y: e.aim.y, agl: e.agl };
        }
      }
      e.tSpawn = this.t;
      this.entities.push(e);
      this.byId.set(e.id, e);
      if (e.groupId) {
        const g = this.groups.get(e.groupId) ?? [];
        g.push(e);
        this.groups.set(e.groupId, g);
      }
    }
  }

  private updateFlocks(): void {
    for (const f of this.flocks) {
      const d = sub(f.target, f.center);
      d.z = 0;
      if (len2(d) < 120) {
        f.target = polar(v3(), this.rng.birds.range(0, 360), this.rng.birds.range(800, 5500));
      } else {
        f.center = add(f.center, scale(norm(d), 4 * DT));
      }
    }
  }

  private makeWorld(): BehaviourWorld {
    const sim = this;
    return {
      get t() {
        return sim.t;
      },
      dt: DT,
      terrain: this.terrain,
      rng: this.rng.behaviour,
      birdRng: this.rng.birds,
      group: (id) => (id ? (sim.groups.get(id) ?? []) : []),
      flockCenter: (i) => sim.flocks[i]?.center ?? v3(),
      impact: (e) => sim.impact(e),
      reconComplete: (e) => sim.reconComplete(e),
      exit: (e) => sim.exitEntity(e),
      landed: (e) => {
        e.flying = false;
        e.vel = v3();
      },
    };
  }

  // ------------------------------------------------------------------------
  // sensors -> tracks
  // ------------------------------------------------------------------------

  /** A position fix from radar or the camera's laser rangefinder. */
  fix(e: Entity, sensor: "radar" | "cam", meas: Vec3): void {
    let tr = this.trackByEntity.get(e.id);
    if (!tr) {
      tr = this.newTrack(e, meas);
    } else {
      const dtf = this.t - tr.lastFix;
      if (dtf > COAST_S * 2) {
        tr.est = meas;
        tr.vel = v3();
      } else if (dtf > 1e-6) {
        const pred = add(tr.est, scale(tr.vel, dtf));
        const r = sub(meas, pred);
        const a = sensor === "cam" ? 0.85 : 0.5;
        const b = sensor === "cam" ? 0.4 : 0.25;
        tr.est = add(pred, scale(r, a));
        tr.vel = add(tr.vel, scale(r, b / dtf));
      }
    }
    tr.lastFix = this.t;
    tr.src[sensor] = this.t;
    tr.speedSamples.push(Math.hypot(tr.vel.x, tr.vel.y));
    if (tr.speedSamples.length > 20) tr.speedSamples.shift();
    tr.altSamples.push(tr.est.z - this.terrain.height(tr.est.x, tr.est.y));
    if (tr.altSamples.length > 20) tr.altSamples.shift();
  }

  private newTrack(e: Entity, meas: Vec3): Track {
    const id = `T-${String(this.nextTrackNum++).padStart(2, "0")}`;
    const iffSensor = this.sensors.find((s) => s.type === "iff");
    const rf = this.strobes.get(`rf:${e.id}`);
    const tr: Track = {
      id,
      idx: this.tracks.length,
      entityId: e.id,
      est: meas,
      vel: v3(),
      lastFix: this.t,
      firstFix: this.t,
      displayed: false,
      src: { radar: -Infinity, rf: rf ? rf.t : -Infinity, ac: -Infinity, cam: -Infinity },
      rfBand: rf?.band ?? null,
      iff: !iffSensor || iffSensor.status === "down" ? "unavailable" : "pending",
      hooked: false,
      hookT: null,
      label: "unknown",
      labelT: null,
      decision: "none",
      authority: "none",
      authorityAt: null,
      engagedBy: [],
      down: false,
      downT: null,
      speedSamples: [],
      altSamples: [],
      thermalSeen: null,
      aid: null,
      aidLogged: null,
    };
    this.tracks.push(tr);
    this.trackById.set(id, tr);
    this.trackByEntity.set(e.id, tr);
    e.trackId = id;
    return tr;
  }

  /** Bearing-only detection from the RF or acoustic sensor. */
  strobe(e: Entity, sensor: "rf" | "ac", from: Vec3, brg: number, band: string | null): void {
    this.strobes.set(`${sensor}:${e.id}`, { sensor, entityId: e.id, from, bearing: brg, band, t: this.t });
    const tr = this.trackByEntity.get(e.id);
    if (tr) {
      tr.src[sensor] = this.t;
      if (sensor === "rf" && band) tr.rfBand = band;
    }
  }

  private updateTracks(): void {
    for (const tr of this.tracks) {
      if (tr.down) continue;
      const e = this.byId.get(tr.entityId)!;
      const shouldDown = e.phase === "falling" || (!e.flying && e.outcome !== "exited");
      if (shouldDown) {
        tr.down = true;
        tr.downT = this.t;
        tr.displayed = false;
        if (this.camera.lockTrack === tr.id) this.cameraUnlock();
        if (this.camera.cueTrack === tr.id) this.camera.cueTrack = null;
        continue;
      }
      const disp = e.flying && this.t - tr.lastFix <= COAST_S;
      if (disp && !tr.displayed) {
        if (e.tFirstDisplayed === null) {
          e.tFirstDisplayed = this.t;
          const p = tr.est;
          this.emit("track_new", {
            track: tr.id,
            entity: e.id,
            data: { sources: this.sourceList(tr), range: Math.round(len2(p)), bearing: Math.round(bearing(v3(), p)) },
          });
          this.say(`NEW TRACK ${tr.id} · brg ${String(Math.round(bearing(v3(), p))).padStart(3, "0")} · ${(len2(p) / 1000).toFixed(1)} km`, "info");
        } else {
          this.emit("track_regained", { track: tr.id, entity: e.id });
        }
      } else if (!disp && tr.displayed) {
        this.emit("track_lost", { track: tr.id, entity: e.id });
      }
      tr.displayed = disp;
    }
  }

  private sourceList(tr: Track): string[] {
    const s: string[] = [];
    if (this.t - tr.src.radar < 2.5) s.push("radar");
    if (this.t - tr.src.rf < 2) s.push("rf");
    if (this.t - tr.src.ac < 2.5) s.push("acoustic");
    if (this.t - tr.src.cam < 1) s.push("camera");
    return s;
  }

  // ------------------------------------------------------------------------
  // camera
  // ------------------------------------------------------------------------

  cameraSpec(): SensorSpec {
    const s = this.sensors.find((x) => x.type === "eoir");
    return s?.spec ?? { name: "EO/IR", type: "eoir", range_m: 8000, update_s: 0, params: {}, source: null, illustrative: true };
  }

  cameraPos(): Vec3 {
    const s = this.sensors.find((x) => x.type === "eoir");
    return s ? s.pos : v3(0, 0, this.terrain.height(0, 0) + 10);
  }

  cameraAvailable(): boolean {
    const s = this.sensors.find((x) => x.type === "eoir");
    return !!s && s.status !== "down";
  }

  private updateCamera(): void {
    const cam = this.camera;
    const from = this.cameraPos();
    if (!this.cameraAvailable()) {
      if (cam.lockEntity) this.cameraUnlock();
      return;
    }
    if (cam.lockEntity) {
      const e = this.byId.get(cam.lockEntity);
      const can = e && e.flying && e.phase !== "falling" ? cameraCanSee(this, e, from) : { ok: false };
      if (!e || !can.ok) {
        this.say(`Camera lost lock${cam.lockTrack ? ` on ${cam.lockTrack}` : ""}`, "warn");
        this.cameraUnlock();
      } else {
        cam.targetAz = bearing(from, e.pos);
        cam.targetEl = elevation(from, e.pos);
        if (this.t - this.lastCamFix >= 0.25) {
          this.lastCamFix = this.t;
          const sigma = this.cameraSpec().params.lrf_sigma_m ?? 2;
          const r = this.rng.radar;
          this.fix(e, "cam", v3(e.pos.x + r.gauss() * sigma, e.pos.y + r.gauss() * sigma, e.pos.z + r.gauss() * sigma));
          const tr = this.trackByEntity.get(e.id);
          if (tr && cam.mode === "ir") tr.thermalSeen = e.spec.thermal;
        }
      }
    } else if (cam.cueTrack) {
      const tr = this.trackById.get(cam.cueTrack);
      if (!tr || tr.down) cam.cueTrack = null;
      else {
        const p = this.predicted(tr);
        cam.targetAz = bearing(from, p);
        cam.targetEl = elevation(from, p);
      }
    }
    const step = (this.cameraSpec().params.slew_dps ?? 40) * DT;
    cam.az = (cam.az + clamp(angleDiff(cam.targetAz, cam.az), -step, step) + 360) % 360;
    cam.el = cam.el + clamp(cam.targetEl - cam.el, -step, step);
  }

  private logCamera(): void {
    if (this.t - this.lastCamLog < 1) return;
    this.lastCamLog = this.t;
    const c = this.camera;
    this.emit("camera", {
      data: { az: Math.round(c.az), el: Math.round(c.el * 10) / 10, fov: Math.round(c.fov * 10) / 10, mode: c.mode, lock: c.lockTrack, cue: c.cueTrack },
    });
  }

  // ------------------------------------------------------------------------
  // outcomes (called by behaviours and effectors)
  // ------------------------------------------------------------------------

  private setOutcome(e: Entity, o: Outcome, by: string | null): void {
    e.outcome = o;
    e.outcomeT = this.t;
    e.outcomeBy = by;
  }

  neutralise(e: Entity, f: EffectorState): void {
    if (!e.flying || e.phase === "falling") return;
    if (e.outcome === "active") this.setOutcome(e, "neutralised", f.id);
    e.phase = "falling";
    this.emit("neutralised", {
      track: e.trackId,
      entity: e.id,
      data: { effector: f.id, kind: f.spec.kind, hostile: e.spec.hostile, friendly: e.cls === "friendly_uav", civil: e.cls === "civil_drone", bird: e.cls === "bird" },
    });
  }

  linkLost(e: Entity, f: EffectorState): void {
    onLinkLost(e, this.world);
    if (e.outcome === "active") this.setOutcome(e, "link_lost", f.id);
    this.emit("link_lost", { track: e.trackId, entity: e.id, data: { effector: f.id, hostile: e.spec.hostile } });
    if (!e.spec.hostile) {
      this.emit("friendly_affected", { track: e.trackId, entity: e.id, data: { effect: "link_lost", effector: f.id, cls: e.cls } });
      if (e.cls === "friendly_uav") this.say("OWN UAV REPORTS LOST LINK (jamming)", "alert");
    }
  }

  divert(e: Entity, f: EffectorState): void {
    if (e.cls === "friendly_uav") {
      // INS-aided: degraded, not diverted
      this.emit("friendly_affected", { track: e.trackId, entity: e.id, data: { effect: "gnss_degraded", effector: f.id, cls: e.cls } });
      this.say("OWN UAV REPORTS GNSS INTERFERENCE", "warn");
      return;
    }
    onDiverted(e, this.world);
    if (e.outcome === "active") this.setOutcome(e, "diverted", f.id);
    this.emit("diverted", { track: e.trackId, entity: e.id, data: { effector: f.id, hostile: e.spec.hostile } });
    if (!e.spec.hostile) this.emit("friendly_affected", { track: e.trackId, entity: e.id, data: { effect: "diverted", effector: f.id, cls: e.cls } });
  }

  private impact(e: Entity): void {
    e.flying = false;
    e.vel = v3();
    if (e.diverted || e.outcome !== "active") return; // spoofed drones crash into empty fields
    const asset = this.sc.map.assets.find((a) => dist2(e.pos, v3(a.pos[0], a.pos[1], 0)) <= a.radius_m + 40);
    if (e.cls === "decoy" || e.spec.damage <= 0) {
      this.setOutcome(e, "expended", null);
      this.emit("expended", { track: e.trackId, entity: e.id, data: { asset: asset?.id ?? null } });
      return;
    }
    this.setOutcome(e, "leaked", null);
    const damage = asset ? e.spec.damage : 0;
    if (asset) this.assetHealth.set(asset.id, Math.max(0, (this.assetHealth.get(asset.id) ?? 100) - damage));
    this.emit("leaker", { track: e.trackId, entity: e.id, data: { asset: asset?.id ?? null, damage } });
    this.say(asset ? `IMPACT · ${asset.name.toUpperCase()} HIT` : "IMPACT near the base (missed assets)", "alert");
  }

  private reconComplete(e: Entity): void {
    this.emit("recon_complete", { track: e.trackId, entity: e.id, data: { asset: e.targetAsset } });
    if (e.trackId) this.say(`${e.trackId} broke orbit: base layout likely compromised`, "warn");
  }

  private exitEntity(e: Entity): void {
    if (e.outcome === "active") this.setOutcome(e, "exited", null);
    e.flying = false;
    this.emit("exited", { track: e.trackId, entity: e.id });
  }

  collateral(f: EffectorState, tr: Track, at: Vec3): void {
    const zone = this.sc.map.no_fire_zones.find((z) => dist2(at, v3(z.center[0], z.center[1], 0)) <= z.radius_m);
    this.emit("collateral", { track: tr.id, entity: tr.entityId, data: { effector: f.id, kind: f.spec.kind, zone: zone?.id ?? null } });
    this.say(`ROUNDS OVER NO-FIRE ZONE ${zone?.name ?? ""}`.trim(), "alert");
  }

  beam(f: EffectorState, to: Vec3): void {
    this.shots.set(`laser:${f.id}`, { kind: "laser", from: f.pos, to, t: this.t });
  }

  tracer(p: Projectile): void {
    this.shots.set(`p:${this.shotSeq++}`, { kind: p.kind, from: p.from, to: p.aim, t: this.t });
  }

  // ------------------------------------------------------------------------
  // trainee / bot commands
  // ------------------------------------------------------------------------

  hook(trackId: string, actor = this.actor): CommandResult {
    const tr = this.trackById.get(trackId);
    if (!tr) return { ok: false, reason: "no such track" };
    if (tr.hooked) return { ok: true };
    if (!tr.displayed) return { ok: false, reason: "track not on display" };
    tr.hooked = true;
    tr.hookT = this.t;
    this.emit("hook", { track: tr.id, entity: tr.entityId, actor, data: { latency: round2(this.t - tr.firstFix) } });
    return { ok: true };
  }

  classify(trackId: string, label: Label, opts: { viaAid?: boolean; actor?: "trainee" | "bot" } = {}): CommandResult {
    const actor = opts.actor ?? this.actor;
    const tr = this.trackById.get(trackId);
    if (!tr) return { ok: false, reason: "no such track" };
    if (!LABELS.includes(label)) return { ok: false, reason: "unknown label" };
    if (tr.down) return { ok: false, reason: "track is down" };
    if (!tr.hooked) {
      const h = this.hook(trackId, actor);
      if (!h.ok) return h;
    }
    if (tr.label === label) return { ok: true };
    const prev = tr.label;
    tr.label = label;
    tr.labelT = this.t;
    this.emit("classify", {
      track: tr.id,
      entity: tr.entityId,
      actor,
      data: {
        label,
        prev,
        via_aid: !!opts.viaAid,
        aid_label: tr.aid?.label ?? null,
        aid_p: tr.aid ? round2(tr.aid.p) : null,
        n_active: this.activeTrackCount(),
        tti: this.tti(tr),
      },
    });
    return { ok: true };
  }

  decide(trackId: string, decision: "ignore" | "monitor", actor = this.actor): CommandResult {
    const tr = this.trackById.get(trackId);
    if (!tr) return { ok: false, reason: "no such track" };
    if (tr.down) return { ok: false, reason: "track is down" };
    if (!tr.hooked) {
      const h = this.hook(trackId, actor);
      if (!h.ok) return h;
    }
    tr.decision = decision;
    this.emit("decision", {
      track: tr.id,
      entity: tr.entityId,
      actor,
      data: { decision, label: tr.label, roe: this.roe, tti: this.tti(tr), n_active: this.activeTrackCount() },
    });
    return { ok: true };
  }

  requestAuthority(trackId: string, actor = this.actor): CommandResult {
    const tr = this.trackById.get(trackId);
    if (!tr) return { ok: false, reason: "no such track" };
    if (tr.authority !== "none") return { ok: true };
    tr.authority = "requested";
    tr.authorityAt = this.t;
    this.authorityQueue.push({ track: tr.id, at: this.t + this.sc.roe.authority_delay_s });
    this.emit("authority_request", { track: tr.id, entity: tr.entityId, actor, data: { roe: this.roe, label: tr.label } });
    this.say(`${tr.id}: authority to engage requested`, "info");
    return { ok: true };
  }

  private processAuthority(): void {
    while (this.authorityQueue.length && this.authorityQueue[0].at <= this.t) {
      const q = this.authorityQueue.shift()!;
      const tr = this.trackById.get(q.track);
      if (!tr) continue;
      tr.authority = "granted";
      this.emit("authority_granted", { track: tr.id, entity: tr.entityId });
      this.say(`${tr.id}: AUTHORITY GRANTED`, "good");
    }
  }

  engage(trackId: string, effectorId: string, actor = this.actor): CommandResult {
    const tr = this.trackById.get(trackId);
    const f = this.effectors.find((x) => x.id === effectorId);
    if (!tr) return { ok: false, reason: "no such track" };
    if (!f) return { ok: false, reason: "no such effector" };
    return doEngage(this, f, tr, actor);
  }

  cease(effectorId: string, actor = this.actor): CommandResult {
    const f = this.effectors.find((x) => x.id === effectorId);
    if (!f) return { ok: false, reason: "no such effector" };
    doCease(this, f, actor);
    return { ok: true };
  }

  cameraSlew(az: number, el: number): void {
    this.camera.cueTrack = null;
    if (this.camera.lockEntity) this.cameraUnlock();
    this.camera.targetAz = ((az % 360) + 360) % 360;
    this.camera.targetEl = clamp(el, -10, 85);
  }

  /** Nudge the camera (mouse drag / arrow keys) without fighting the slew limiter. */
  cameraNudge(dAz: number, dEl: number): void {
    this.cameraSlew(this.camera.targetAz + dAz, this.camera.targetEl + dEl);
  }

  cameraZoom(fov: number): void {
    this.camera.fov = clampFov(this, fov);
  }

  cameraMode(mode: "eo" | "ir"): void {
    this.camera.mode = mode;
  }

  cameraCue(trackId: string): CommandResult {
    const tr = this.trackById.get(trackId);
    if (!tr || tr.down) return { ok: false, reason: "no such track" };
    if (!this.cameraAvailable()) return { ok: false, reason: "camera down" };
    if (this.camera.lockEntity) this.cameraUnlock();
    this.camera.cueTrack = tr.id;
    return { ok: true };
  }

  cameraUnlock(): void {
    this.camera.lockEntity = null;
    this.camera.lockTrack = null;
  }

  /**
   * The trainee clicked an object in the camera picture. If it really is
   * visible there, the turret locks on and its laser rangefinder produces a
   * precise track: this is how drones the radar filtered out get found.
   */
  cameraDesignate(entityId: string, actor = this.actor): CommandResult {
    const e = this.byId.get(entityId);
    if (!e || !e.flying || e.phase === "falling") return { ok: false, reason: "nothing there" };
    if (!this.cameraAvailable()) return { ok: false, reason: "camera down" };
    const from = this.cameraPos();
    const off = Math.hypot(angleDiff(bearing(from, e.pos), this.camera.az), elevation(from, e.pos) - this.camera.el);
    if (off > this.camera.fov * 0.6) return { ok: false, reason: "outside field of view" };
    const can = cameraCanSee(this, e, from);
    if (!can.ok) return { ok: false, reason: can.reason };
    const isNew = !this.trackByEntity.has(e.id);
    this.fix(e, "cam", v3(e.pos.x, e.pos.y, e.pos.z));
    const tr = this.trackByEntity.get(e.id)!;
    this.camera.lockEntity = e.id;
    this.camera.lockTrack = tr.id;
    this.camera.cueTrack = null;
    this.lastCamFix = this.t;
    if (this.camera.mode === "ir") tr.thermalSeen = e.spec.thermal;
    this.emit("camera_designate", { track: tr.id, entity: e.id, actor, data: { new: isNew, mode: this.camera.mode, fov: round2(this.camera.fov) } });
    if (isNew) this.say(`${tr.id} acquired by camera`, "info");
    this.updateTracks();
    return { ok: true, track: tr.id };
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause", { actor: this.actor });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emit("resume", { actor: this.actor });
  }

  abort(): void {
    if (!this.ended) this.end("aborted");
  }

  // ------------------------------------------------------------------------
  // derived facts
  // ------------------------------------------------------------------------

  predicted(tr: Track): Vec3 {
    return add(tr.est, scale(tr.vel, Math.min(this.t - tr.lastFix, COAST_S)));
  }

  /** Estimated time to the nearest defended asset, or null if not closing. */
  tti(tr: Track): number | null {
    const p = this.predicted(tr);
    let best: number | null = null;
    for (const a of this.sc.map.assets) {
      const to = v3(a.pos[0] - p.x, a.pos[1] - p.y, 0);
      const d = len2(to);
      const closing = dot(v3(tr.vel.x, tr.vel.y, 0), norm(to));
      if (closing < 2) continue;
      const tt = d / closing;
      if (best === null || tt < best) best = tt;
    }
    return best === null ? null : Math.round(best * 10) / 10;
  }

  activeTrackCount(): number {
    let n = 0;
    for (const tr of this.tracks) if (tr.displayed && !tr.down) n++;
    return n;
  }

  inNoFireZone(p: Vec3): boolean {
    return this.sc.map.no_fire_zones.some((z) => dist2(p, v3(z.center[0], z.center[1], 0)) <= z.radius_m);
  }

  weatherFx(): WeatherEffect {
    return this.cat.weather[this.sc.environment.weather];
  }

  // ------------------------------------------------------------------------
  // classification aid hook (PLAN.md 6.12)
  // ------------------------------------------------------------------------

  private runAid(): void {
    if (!this.aidFn || this.aidMode === "off" || this.t - this.lastAid < 1) return;
    this.lastAid = this.t;
    for (const tr of this.tracks) {
      if (!tr.displayed || tr.down) continue;
      tr.aid = this.aidFn(this, tr);
      if (tr.aid && tr.aid.label !== tr.aidLogged) {
        tr.aidLogged = tr.aid.label;
        this.emit("ai_suggestion", { track: tr.id, entity: tr.entityId, data: { label: tr.aid.label, p: round2(tr.aid.p), mode: this.aidMode } });
      }
    }
  }

  // ------------------------------------------------------------------------
  // events, feed, end
  // ------------------------------------------------------------------------

  emit(
    type: EventType,
    opts: { track?: string | null; entity?: string | null; actor?: "trainee" | "sim" | "bot"; data?: Record<string, unknown> } = {},
  ): void {
    this.events.push({
      t: round2(this.t),
      type,
      actor: opts.actor ?? "sim",
      track: opts.track ?? null,
      entity: opts.entity ?? null,
      data: opts.data ?? {},
    });
  }

  say(text: string, level: FeedItem["level"]): void {
    this.feed.push({ t: this.t, text, level });
    if (this.feed.length > 80) this.feed.shift();
  }

  private checkEnd(): void {
    if (this.t >= this.sc.duration_s) return this.end("time_up");
    const unresolved = this.pending.some((p) => p.entity.spec.hostile) || this.entities.some((e) => e.spec.hostile && e.flying && e.outcome === "active");
    if (unresolved || this.projectiles.length) {
      this.resolvedAt = null;
      return;
    }
    this.resolvedAt ??= this.t;
    if (this.t - this.resolvedAt >= 4) this.end("all_resolved");
  }

  private end(reason: SessionResult["ended_reason"]): void {
    for (const f of this.effectors) if (f.status === "active" || f.status === "slewing") doCease(this, f, "sim", "mission_end");
    this.ended = true;
    this.endReason = reason;
    this.emit("session_end", {
      data: { reason, spend: this.spend, assets_health: Object.fromEntries(this.assetHealth) },
    });
    this.recorder?.record(this);
    this.say(reason === "time_up" ? "MISSION TIME UP" : reason === "aborted" ? "MISSION ABORTED" : "ALL THREATS RESOLVED", "info");
  }

  // ------------------------------------------------------------------------
  // outputs
  // ------------------------------------------------------------------------

  view(): SimView {
    const t = this.t;
    const tracks: TrackView[] = [];
    for (const tr of this.tracks) {
      if (tr.down && t - (tr.downT ?? 0) > SPLASH_S) continue;
      if (!tr.down && !tr.displayed && t - tr.lastFix > LOST_SHOWN_S) continue;
      const p = tr.down ? tr.est : this.predicted(tr);
      tracks.push({
        id: tr.id,
        x: p.x,
        y: p.y,
        z: p.z,
        agl: p.z - this.terrain.height(p.x, p.y),
        vx: tr.vel.x,
        vy: tr.vel.y,
        vz: tr.vel.z,
        speed: Math.hypot(tr.vel.x, tr.vel.y),
        range: len2(p),
        bearing: bearing(v3(), p),
        tti: tr.down ? null : this.tti(tr),
        displayed: tr.displayed,
        down: tr.down,
        hooked: tr.hooked,
        label: tr.label,
        hostility: hostilityOf(tr.label),
        decision: tr.decision,
        authority: tr.authority,
        iff: tr.iff,
        sources: {
          radar: t - tr.src.radar < 2.5,
          rf: t - tr.src.rf < 2,
          ac: t - tr.src.ac < 2.5,
          cam: t - tr.src.cam < 1,
        },
        rfBand: tr.rfBand,
        engagedBy: this.effectors.filter((f) => f.targetTrack === tr.id && (f.status === "active" || f.status === "slewing")).map((f) => f.id),
        age: t - tr.firstFix,
        aid: tr.aid,
      });
    }
    const strobes = [...this.strobes.values()]
      .filter((s) => t - s.t <= 2.5 && !this.trackByEntity.get(s.entityId)?.displayed)
      .map((s) => ({ sensor: s.sensor, x0: s.from.x, y0: s.from.y, bearing: s.bearing, band: s.band }));
    const effectors: EffectorView[] = this.effectors.map((f) => {
      let progress: number | null = null;
      if (f.status === "active" && (f.spec.kind === "rf_jam" || f.spec.kind === "gnss_spoof")) progress = 1 - (f.until - t) / f.spec.duration_s;
      if (f.status === "active" && f.spec.kind === "laser" && f.targetEntity) {
        const e = this.byId.get(f.targetEntity);
        if (e) progress = Math.min(1, f.dwell / (f.spec.dwell_s * (this.cat.laser_dwell[e.cls] ?? 1) * this.weatherFx().laser_dwell));
      }
      const active = f.status === "active" || f.status === "slewing";
      return {
        id: f.id,
        type: f.type,
        name: f.spec.name,
        kind: f.spec.kind,
        kill: f.spec.kill,
        x: f.pos.x,
        y: f.pos.y,
        range: f.spec.range_m,
        status: f.status === "ready" && t < f.readyAt ? "reloading" : f.status,
        ammo: f.ammo,
        costPerUse: f.spec.cost_inr * (f.spec.kill === "soft" ? 1 : f.spec.rounds_per_shot),
        targetTrack: active ? f.targetTrack : null,
        sector: active && f.spec.sector_half_deg > 0 ? { bearing: f.bearing, half: f.spec.sector_half_deg } : null,
        progress,
      };
    });
    const shots: ShotView[] = [...this.shots.values()].map((s) => ({ kind: s.kind, x0: s.from.x, y0: s.from.y, x1: s.to.x, y1: s.to.y, age: t - s.t }));
    for (const p of this.projectiles) {
      if (p.kind === "gun") continue;
      const k = clamp((t - p.fireT) / Math.max(0.01, p.impactT - p.fireT), 0, 1);
      const target = p.targetEntity ? this.byId.get(p.targetEntity) : null;
      const to = target ? target.pos : p.aim;
      shots.push({ kind: p.kind, x0: p.from.x, y0: p.from.y, x1: p.from.x + (to.x - p.from.x) * k, y1: p.from.y + (to.y - p.from.y) * k, age: -1 });
    }
    return {
      t,
      duration: this.sc.duration_s,
      tracks,
      strobes,
      effectors,
      shots,
      sensors: this.sensors.map((s) => ({ id: s.id, type: s.type, name: s.spec.name, status: s.status, x: s.pos.x, y: s.pos.y, range: s.spec.range_m })),
      camera: { ...this.camera },
      roe: this.roe,
      assets: this.sc.map.assets.map((a) => ({ id: a.id, name: a.name, health: this.assetHealth.get(a.id) ?? 100 })),
      spend: this.spend,
      ended: this.ended,
      endReason: this.endReason,
      feed: this.feed.slice(-30),
    };
  }

  /** What the EO/IR camera can render: truth, as pixels only. */
  renderables(): Renderable[] {
    const out: Renderable[] = [];
    for (const e of this.entities) {
      if (!e.flying && (e.outcomeT === null || this.t - e.outcomeT > 3)) continue;
      const sp = Math.hypot(e.vel.x, e.vel.y);
      out.push({
        id: e.id,
        cls: e.cls,
        x: e.pos.x,
        y: e.pos.y,
        z: e.pos.z,
        heading: sp > 0.3 ? Math.atan2(e.vel.x, e.vel.y) / DEG : 0,
        pitch: Math.atan2(e.vel.z, Math.max(sp, 0.1)) / DEG,
        flying: e.flying && e.phase !== "falling",
        flap: e.flap,
        size: e.spec.size_m,
        thermal: e.spec.thermal,
      });
    }
    return out;
  }

  effectorReady(id: string): boolean {
    const f = this.effectors.find((x) => x.id === id);
    return !!f && effectorReady(this, f);
  }

  truth(): TruthEntity[] {
    return this.entities.map((e) => ({
      id: e.id,
      cls: e.cls,
      label: e.spec.label,
      hostile: e.spec.hostile,
      link: e.spec.link,
      nav: e.spec.nav,
      cost_inr: e.spec.cost_inr,
      damage: e.spec.damage,
      wave: e.waveId,
      tactic: e.tactic,
      iff: e.iff,
      track: e.trackId,
      t_spawn: round2(e.tSpawn),
      t_first_displayed: e.tFirstDisplayed === null ? null : round2(e.tFirstDisplayed),
      outcome: e.outcome,
      outcome_t: e.outcomeT === null ? null : round2(e.outcomeT),
      outcome_by: e.outcomeBy,
    }));
  }

  result(): SessionResult {
    return {
      scenario_id: this.sc.id,
      seed: this.sc.seed,
      actor: this.actor,
      bot: this.bot,
      duration_s: round2(this.t),
      ended_reason: this.endReason ?? "aborted",
      assets_health: Object.fromEntries(this.assetHealth),
      aid_mode: this.aidMode,
      events: this.events,
      truth: this.truth(),
      replay: this.recorder ? this.recorder.build(this) : null,
    };
  }
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

