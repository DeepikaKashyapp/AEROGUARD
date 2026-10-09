import type { Replay, ReplayFrame } from "./contracts.ts";
import { DECISIONS, LABELS, type Sim } from "./sim.ts";

/**
 * Records compact snapshots at 2 Hz for the after-action replay (PLAN.md 4.3:
 * replay plays back recorded frames, it never re-simulates).
 */
export class ReplayRecorder {
  readonly dt = 0.5;
  private frames: ReplayFrame[] = [];
  private next = 0;

  maybeRecord(sim: Sim): void {
    if (sim.t + 1e-9 < this.next) return;
    this.next = sim.t + this.dt;
    this.record(sim);
  }

  record(sim: Sim): void {
    const e: number[] = [];
    for (const x of sim.entities) {
      const recent = x.outcomeT !== null && sim.t - x.outcomeT < 3;
      if (!x.flying && !recent) continue;
      e.push(x.idx, Math.round(x.pos.x), Math.round(x.pos.y), Math.round(x.pos.z), x.flying && x.phase !== "falling" ? 0 : 1);
    }
    const tr: number[] = [];
    for (const t of sim.tracks) {
      const downRecent = t.down && sim.t - (t.downT ?? 0) < 6;
      if (!t.displayed && !downRecent) continue;
      const p = t.down ? t.est : sim.predicted(t);
      tr.push(t.idx, Math.round(p.x), Math.round(p.y), t.down ? 2 : 1, LABELS.indexOf(t.label), DECISIONS.indexOf(t.decision), t.hooked ? 1 : 0);
    }
    const fx: number[] = [];
    for (const f of sim.effectors) {
      if ((f.status === "active" || f.status === "slewing") && f.targetTrack) {
        const trk = sim.trackById.get(f.targetTrack);
        if (trk) fx.push(f.idx, trk.idx);
      }
    }
    const c = sim.camera;
    this.frames.push({
      t: Math.round(sim.t * 100) / 100,
      e,
      tr,
      cam: [Math.round(c.az * 10) / 10, Math.round(c.el * 10) / 10, Math.round(c.fov * 100) / 100, c.mode === "ir" ? 1 : 0],
      fx,
    });
  }

  build(sim: Sim): Replay {
    return {
      dt: this.dt,
      entities: sim.entities.map((x) => ({ id: x.id, cls: x.cls })),
      tracks: sim.tracks.map((t) => t.id),
      effectors: sim.effectors.map((f) => f.id),
      frames: this.frames,
    };
  }
}
