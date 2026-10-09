/**
 * Decodes the sim's 2 Hz replay frames into map models at any time t, with
 * interpolation between frames. Replay never re-simulates (PLAN.md 4.3).
 */
import { DECISIONS, LABELS, hostilityOf, type Catalogue, type ReplayFrame, type Scenario, type SimEvent } from "@cuas/sim";
import type { MapModel, MapTrack } from "../console/mapDraw.ts";
import type { SessionBundle } from "../types.ts";

interface DecodedFrame {
  t: number;
  ents: Map<number, { x: number; y: number; z: number; down: boolean }>;
  trks: Map<number, { x: number; y: number; state: number; label: number; decision: number; hooked: boolean }>;
  cam: number[];
  fx: [number, number][];
}

export class ReplayModel {
  readonly frames: DecodedFrame[];
  readonly duration: number;
  private sc: Scenario;
  private trackIds: string[];
  private entityCls: string[];
  private effectors: MapModel["effectors"];
  private sensorEvents: SimEvent[];
  private camPos: { x: number; y: number } | null;

  constructor(b: SessionBundle, cat: Catalogue) {
    const r = b.replay!;
    this.sc = b.scenario;
    this.trackIds = r.tracks;
    this.entityCls = r.entities.map((e) => e.cls);
    this.frames = r.frames.map(decode);
    this.duration = this.frames.length ? this.frames[this.frames.length - 1].t : 0;
    this.effectors = b.scenario.effectors.map((f) => {
      const s = cat.effectors[f.type];
      return { id: f.id, kind: s.kind, kill: s.kill, x: f.pos[0], y: f.pos[1], range: s.range_m, status: "ready" as const, sector: null, targetTrack: null };
    });
    this.sensorEvents = (b.events ?? []).filter((e) => e.type === "sensor_state");
    const cam = b.scenario.sensors.find((s) => s.type.includes("eoir"));
    this.camPos = cam ? { x: cam.pos[0], y: cam.pos[1] } : null;
  }

  private index(t: number): number {
    let lo = 0;
    let hi = this.frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.frames[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  at(t: number, truth: boolean): MapModel {
    if (!this.frames.length) return { t, tracks: [], strobes: [], effectors: this.effectors, shots: [], sensorsDown: [], camera: null };
    const i = this.index(t);
    const f0 = this.frames[i];
    const f1 = this.frames[Math.min(i + 1, this.frames.length - 1)];
    const span = Math.max(1e-6, f1.t - f0.t);
    const a = Math.max(0, Math.min(1, (t - f0.t) / span));

    const tracks: MapTrack[] = [];
    for (const [idx, p0] of f0.trks) {
      const p1 = f1.trks.get(idx);
      const x = p1 ? p0.x + (p1.x - p0.x) * a : p0.x;
      const y = p1 ? p0.y + (p1.y - p0.y) * a : p0.y;
      const label = LABELS[p0.label] ?? "unknown";
      const engaged = f0.fx.some(([, ti]) => ti === idx);
      tracks.push({
        id: this.trackIds[idx],
        x,
        y,
        vx: p1 ? (p1.x - p0.x) / span : 0,
        vy: p1 ? (p1.y - p0.y) / span : 0,
        hostility: hostilityOf(label),
        label,
        displayed: p0.state === 1,
        down: p0.state === 2,
        hooked: p0.hooked,
        decision: DECISIONS[p0.decision] ?? "none",
        engaged,
      });
    }

    const effectors = this.effectors.map((e, ei) => {
      const fx = f0.fx.find(([fi]) => fi === ei);
      if (!fx) return e;
      const tr = f0.trks.get(fx[1]);
      const sector = (e.kind === "rf_jam" || e.kind === "gnss_spoof") && tr
        ? { bearing: (Math.atan2(tr.x - e.x, tr.y - e.y) * 180) / Math.PI, half: e.kind === "rf_jam" ? 15 : 20 }
        : null;
      return { ...e, status: "active" as const, targetTrack: this.trackIds[fx[1]], sector };
    });

    const down = new Map<string, boolean>();
    for (const ev of this.sensorEvents) {
      if (ev.t > t) break;
      down.set(String(ev.data.sensor), ev.data.state === "down");
    }
    const sensorsDown = [...down].filter(([, d]) => d).map(([s]) => s);

    const model: MapModel = {
      t,
      tracks,
      strobes: [],
      effectors,
      shots: [],
      sensorsDown,
      camera: this.camPos && f0.cam.length ? { ...this.camPos, az: f0.cam[0], fov: f0.cam[2] } : null,
    };
    if (truth) {
      model.truth = [];
      for (const [idx, p0] of f0.ents) {
        const p1 = f1.ents.get(idx);
        model.truth.push({
          id: String(idx),
          cls: this.entityCls[idx],
          x: p1 ? p0.x + (p1.x - p0.x) * a : p0.x,
          y: p1 ? p0.y + (p1.y - p0.y) * a : p0.y,
          down: p0.down,
        });
      }
    }
    return model;
  }

  get scenario(): Scenario {
    return this.sc;
  }
}

function decode(f: ReplayFrame): DecodedFrame {
  const ents = new Map<number, { x: number; y: number; z: number; down: boolean }>();
  for (let i = 0; i + 4 < f.e.length + 0.5; i += 5) ents.set(f.e[i], { x: f.e[i + 1], y: f.e[i + 2], z: f.e[i + 3], down: f.e[i + 4] === 1 });
  const trks = new Map<number, { x: number; y: number; state: number; label: number; decision: number; hooked: boolean }>();
  for (let i = 0; i + 6 < f.tr.length + 0.5; i += 7)
    trks.set(f.tr[i], { x: f.tr[i + 1], y: f.tr[i + 2], state: f.tr[i + 3], label: f.tr[i + 4], decision: f.tr[i + 5], hooked: f.tr[i + 6] === 1 });
  const fx: [number, number][] = [];
  for (let i = 0; i + 1 < f.fx.length + 0.5; i += 2) fx.push([f.fx[i], f.fx[i + 1]]);
  return { t: f.t, ents, trks, cam: f.cam, fx };
}
