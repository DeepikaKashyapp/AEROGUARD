/**
 * Tactical display renderer (canvas 2D), shared by the live console and the
 * AAR replay. Draws only what a C2 operator would see: tracks, strobes,
 * coverage, effector activity. Ground truth is drawn only when the AAR's
 * "ground truth" toggle passes it in.
 */
import type { EffectorView, Hostility, Scenario, ShotView, StrobeView, Terrain } from "@cuas/sim";

export interface MapTrack {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hostility: Hostility;
  label: string;
  displayed: boolean;
  down: boolean;
  hooked: boolean;
  decision: string;
  engaged: boolean;
  tti?: number | null;
}

export interface MapModel {
  t: number;
  tracks: MapTrack[];
  strobes: StrobeView[];
  effectors: Pick<EffectorView, "id" | "kind" | "kill" | "x" | "y" | "range" | "status" | "sector" | "targetTrack">[];
  shots: ShotView[];
  sensorsDown: string[];
  camera: { x: number; y: number; az: number; fov: number } | null;
  truth?: { id: string; x: number; y: number; cls: string; down: boolean }[];
}

export const HOSTILITY_COLOR: Record<Hostility, string> = {
  unknown: "#ffd23f",
  hostile: "#ff5252",
  friend: "#59a8ff",
  neutral: "#4cd387",
};

const TRUTH_COLOR: Record<string, string> = {
  bird: "#4cd387",
  friendly_uav: "#59a8ff",
  civil_drone: "#9be3b8",
  recon_quad: "#ff9a3c",
  fpv_rf: "#ff5252",
  fpv_fiber: "#ff2d6f",
  loitering_munition: "#ff4dd2",
  decoy: "#c7a6ff",
};

export class MapRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly sc: Scenario;
  readonly terrain: Terrain;
  private relief: HTMLCanvasElement;
  cx = 0;
  cy = 0;
  k = 0.05; // px per metre
  private w = 0;
  private h = 0;
  private dpr = 1;
  showRanges = false;
  highlightEffector: string | null = null;

  constructor(canvas: HTMLCanvasElement, sc: Scenario, terrain: Terrain) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.sc = sc;
    this.terrain = terrain;
    this.relief = renderRelief(terrain);
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(10, Math.round(r.width));
    const h = Math.max(10, Math.round(r.height));
    if (w === this.w && h === this.h) return;
    const first = this.w === 0;
    this.w = w;
    this.h = h;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    if (first) this.fit(13000);
  }

  fit(metres: number): void {
    this.k = Math.min(this.w, this.h) / metres;
    this.cx = 0;
    this.cy = 0;
  }

  sx = (x: number) => this.w / 2 + (x - this.cx) * this.k;
  sy = (y: number) => this.h / 2 - (y - this.cy) * this.k;
  wx = (sx: number) => this.cx + (sx - this.w / 2) / this.k;
  wy = (sy: number) => this.cy - (sy - this.h / 2) / this.k;

  zoomAt(px: number, py: number, factor: number): void {
    const x = this.wx(px);
    const y = this.wy(py);
    this.k = Math.max(0.008, Math.min(2, this.k * factor));
    this.cx = x - (px - this.w / 2) / this.k;
    this.cy = y + (py - this.h / 2) / this.k;
  }

  pan(dx: number, dy: number): void {
    this.cx -= dx / this.k;
    this.cy += dy / this.k;
  }

  hitTrack(model: MapModel, px: number, py: number): string | null {
    let best: string | null = null;
    let bd = 14;
    for (const t of model.tracks) {
      if (!t.displayed && !t.down) continue;
      const d = Math.hypot(this.sx(t.x) - px, this.sy(t.y) - py);
      if (d < bd) {
        bd = d;
        best = t.id;
      }
    }
    return best;
  }

  draw(model: MapModel, selected: string | null): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#070a0e";
    ctx.fillRect(0, 0, this.w, this.h);
    const half = this.sc.map.size_m / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.relief, this.sx(-half), this.sy(half), half * 2 * this.k, half * 2 * this.k);
    ctx.globalAlpha = 1;
    this.drawRings();
    this.drawZones();
    this.drawSensors(model);
    this.drawAssets();
    this.drawEffectors(model);
    if (model.camera) this.drawCamera(model.camera);
    this.drawStrobes(model.strobes);
    this.drawShots(model);
    if (model.truth) this.drawTruth(model.truth);
    for (const t of model.tracks) this.drawTrack(t, model.t, t.id === selected);
    this.drawScale();
  }

  private drawRings(): void {
    const { ctx } = this;
    const ox = this.sx(0);
    const oy = this.sy(0);
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, monospace";
    for (let r = 1000; r <= 8000; r += 1000) {
      ctx.strokeStyle = r % 2000 === 0 ? "rgba(120,160,190,0.22)" : "rgba(120,160,190,0.1)";
      ctx.beginPath();
      ctx.arc(ox, oy, r * this.k, 0, Math.PI * 2);
      ctx.stroke();
      if (r % 2000 === 0) {
        ctx.fillStyle = "rgba(150,180,200,0.5)";
        ctx.fillText(`${r / 1000} km`, ox + 3, oy - r * this.k - 3);
      }
    }
    ctx.strokeStyle = "rgba(120,160,190,0.18)";
    for (let b = 0; b < 360; b += 30) {
      const a = (b * Math.PI) / 180;
      const r0 = 7700 * this.k;
      const r1 = 8000 * this.k;
      ctx.beginPath();
      ctx.moveTo(ox + Math.sin(a) * r0, oy - Math.cos(a) * r0);
      ctx.lineTo(ox + Math.sin(a) * r1, oy - Math.cos(a) * r1);
      ctx.stroke();
      ctx.fillStyle = "rgba(150,180,200,0.45)";
      const lbl = b === 0 ? "N" : String(b).padStart(3, "0");
      ctx.fillText(lbl, ox + Math.sin(a) * (r1 + 10) - 8, oy - Math.cos(a) * (r1 + 10) + 4);
    }
  }

  private drawZones(): void {
    const { ctx } = this;
    for (const z of this.sc.map.no_fire_zones) {
      const x = this.sx(z.center[0]);
      const y = this.sy(z.center[1]);
      const r = z.radius_m * this.k;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,82,82,0.07)";
      ctx.fill();
      ctx.clip();
      ctx.strokeStyle = "rgba(255,82,82,0.18)";
      for (let i = -r * 2; i < r * 2; i += 8) {
        ctx.beginPath();
        ctx.moveTo(x + i - r, y - r);
        ctx.lineTo(x + i + r, y + r);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = "rgba(255,82,82,0.6)";
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,140,140,0.85)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText(`${z.name.toUpperCase()} · NO-FIRE`, x - r * 0.6, y - r - 4);
    }
    for (const c of this.sc.map.corridors) {
      ctx.strokeStyle = "rgba(89,168,255,0.55)";
      ctx.setLineDash([10, 6]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      c.points.forEach((p, i) => (i ? ctx.lineTo(this.sx(p[0]), this.sy(p[1])) : ctx.moveTo(this.sx(p[0]), this.sy(p[1]))));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      ctx.fillStyle = "rgba(140,190,255,0.8)";
      ctx.font = "11px system-ui, sans-serif";
      const p = c.points[0];
      ctx.fillText(c.name, this.sx(p[0]) + 4, this.sy(p[1]) - 4);
    }
  }

  private drawSensors(model: MapModel): void {
    const { ctx } = this;
    const radar = this.sc.sensors.find((s) => s.type.includes("radar"));
    if (radar) {
      const down = model.sensorsDown.includes(radar.id);
      ctx.strokeStyle = down ? "rgba(255,82,82,0.5)" : "rgba(76,195,255,0.18)";
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.arc(this.sx(radar.pos[0]), this.sy(radar.pos[1]), 10000 * this.k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (model.sensorsDown.length) {
      ctx.fillStyle = "#ff5c5c";
      ctx.font = "bold 12px ui-monospace, monospace";
      ctx.fillText(`SENSOR DOWN: ${model.sensorsDown.join(", ")}`, 12, 20);
    }
  }

  private drawAssets(): void {
    const { ctx } = this;
    ctx.font = "11px system-ui, sans-serif";
    for (const a of this.sc.map.assets) {
      const x = this.sx(a.pos[0]);
      const y = this.sy(a.pos[1]);
      const r = Math.max(4, a.radius_m * this.k);
      ctx.strokeStyle = "rgba(220,230,240,0.75)";
      ctx.fillStyle = "rgba(220,230,240,0.08)";
      ctx.beginPath();
      ctx.rect(x - r, y - r, r * 2, r * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "rgba(220,230,240,0.85)";
      ctx.fillText(a.name, x + r + 4, y + 4);
    }
  }

  private drawEffectors(model: MapModel): void {
    const { ctx } = this;
    for (const f of model.effectors) {
      const x = this.sx(f.x);
      const y = this.sy(f.y);
      const color = f.kill === "soft" ? "#e070ff" : "#ffb020";
      if (this.showRanges || this.highlightEffector === f.id) {
        ctx.strokeStyle = this.highlightEffector === f.id ? color : color + "55";
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(x, y, f.range * this.k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (f.sector) {
        const a0 = ((f.sector.bearing - f.sector.half - 90) * Math.PI) / 180;
        const a1 = ((f.sector.bearing + f.sector.half - 90) * Math.PI) / 180;
        ctx.fillStyle = f.kind === "rf_jam" ? "rgba(224,112,255,0.13)" : "rgba(76,195,255,0.12)";
        ctx.strokeStyle = f.kind === "rf_jam" ? "rgba(224,112,255,0.6)" : "rgba(76,195,255,0.6)";
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, f.range * this.k, a0, a1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = f.status === "empty" ? "#555" : color;
      ctx.beginPath();
      if (f.kill === "soft") {
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x + 4, y);
        ctx.lineTo(x, y + 4);
        ctx.lineTo(x - 4, y);
      } else {
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x + 4, y + 3);
        ctx.lineTo(x - 4, y + 3);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawCamera(cam: { x: number; y: number; az: number; fov: number }): void {
    const { ctx } = this;
    const x = this.sx(cam.x);
    const y = this.sy(cam.y);
    const len = 8000 * this.k;
    const half = Math.max(cam.fov / 2, 0.15);
    ctx.fillStyle = "rgba(120,255,190,0.06)";
    ctx.strokeStyle = "rgba(120,255,190,0.45)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (const a of [cam.az - half, cam.az + half]) {
      const r = (a * Math.PI) / 180;
      ctx.lineTo(x + Math.sin(r) * len, y - Math.cos(r) * len);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private drawStrobes(strobes: StrobeView[]): void {
    const { ctx } = this;
    for (const s of strobes) {
      const a = (s.bearing * Math.PI) / 180;
      const x0 = this.sx(s.x0);
      const y0 = this.sy(s.y0);
      const len = (s.sensor === "rf" ? 5000 : 3000) * this.k;
      ctx.strokeStyle = s.sensor === "rf" ? "rgba(224,112,255,0.7)" : "rgba(255,154,60,0.75)";
      ctx.setLineDash(s.sensor === "rf" ? [8, 5] : [2, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + Math.sin(a) * len, y0 - Math.cos(a) * len);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      if (s.band) {
        ctx.fillStyle = "rgba(224,112,255,0.85)";
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(s.band, x0 + Math.sin(a) * len * 0.7 + 4, y0 - Math.cos(a) * len * 0.7);
      }
    }
  }

  private drawShots(model: MapModel): void {
    const { ctx } = this;
    for (const s of model.shots) {
      const x0 = this.sx(s.x0);
      const y0 = this.sy(s.y0);
      const x1 = this.sx(s.x1);
      const y1 = this.sy(s.y1);
      if (s.kind === "laser") {
        ctx.strokeStyle = "rgba(120,255,160,0.95)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.lineWidth = 1;
      } else if (s.age >= 0) {
        ctx.strokeStyle = s.kind === "gun" ? "rgba(255,176,32,0.85)" : "rgba(255,255,255,0.6)";
        ctx.beginPath();
        ctx.moveTo(x1 + (x0 - x1) * 0.15, y1 + (y0 - y1) * 0.15);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,210,120,0.9)";
        ctx.beginPath();
        ctx.arc(x1, y1, 3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = s.kind === "sam" ? "#fff" : "#ffe08a";
        ctx.beginPath();
        ctx.arc(x1, y1, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
    for (const f of model.effectors) {
      if (!f.targetTrack || f.sector) continue;
      const t = model.tracks.find((x) => x.id === f.targetTrack);
      if (!t) continue;
      ctx.strokeStyle = "rgba(255,176,32,0.35)";
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(this.sx(f.x), this.sy(f.y));
      ctx.lineTo(this.sx(t.x), this.sy(t.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawTruth(truth: NonNullable<MapModel["truth"]>): void {
    const { ctx } = this;
    for (const e of truth) {
      const x = this.sx(e.x);
      const y = this.sy(e.y);
      ctx.fillStyle = e.down ? "rgba(140,140,140,0.6)" : TRUTH_COLOR[e.cls] ?? "#fff";
      ctx.beginPath();
      ctx.arc(x, y, e.cls === "bird" ? 1.6 : 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawTrack(t: MapTrack, now: number, sel: boolean): void {
    const { ctx } = this;
    const x = this.sx(t.x);
    const y = this.sy(t.y);
    const color = HOSTILITY_COLOR[t.hostility];
    if (t.down) {
      ctx.strokeStyle = "rgba(170,170,170,0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 5);
      ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5);
      ctx.lineTo(x - 5, y + 5);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = "rgba(170,170,170,0.8)";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(`${t.id} SPLASH`, x + 8, y + 3);
      return;
    }
    const alpha = t.displayed ? 1 : 0.35;
    ctx.globalAlpha = alpha;
    // velocity leader: where it will be in 30 s
    const sp = Math.hypot(t.vx, t.vy);
    if (sp > 1) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + t.vx * 30 * this.k, y - t.vy * 30 * this.k);
      ctx.stroke();
    }
    drawSymbol(ctx, x, y, t.hostility, 8);
    if (t.engaged) {
      ctx.strokeStyle = "#ffb020";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 12 + 2 * Math.sin(now * 8), 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    if (!t.hooked && t.displayed && Math.floor(now * 3) % 2 === 0) {
      ctx.strokeStyle = "#ffd23f";
      ctx.strokeRect(x - 11, y - 11, 22, 22);
    }
    if (sel) {
      ctx.strokeStyle = "#4cc3ff";
      ctx.lineWidth = 2;
      const s = 14;
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.beginPath();
        ctx.moveTo(x + dx * s, y + dy * (s - 5));
        ctx.lineTo(x + dx * s, y + dy * s);
        ctx.lineTo(x + dx * (s - 5), y + dy * s);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = color;
    ctx.font = "11px ui-monospace, monospace";
    const lbl = t.label !== "unknown" ? ` ${t.label.toUpperCase()}` : "";
    ctx.fillText(`${t.id}${lbl}`, x + 11, y - 6);
    ctx.globalAlpha = 1;
  }

  private drawScale(): void {
    const { ctx } = this;
    const metres = this.k > 0.2 ? 500 : this.k > 0.06 ? 1000 : 2000;
    const px = metres * this.k;
    const x = this.w - px - 16;
    const y = this.h - 16;
    ctx.strokeStyle = "rgba(200,215,230,0.7)";
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = "rgba(200,215,230,0.8)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, x, y - 6);
  }
}

/** MIL-STD-2525-style air track frames (top halves): friend dome, hostile tent, unknown bell, neutral box. */
export function drawSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, h: Hostility, s: number): void {
  ctx.strokeStyle = HOSTILITY_COLOR[h];
  ctx.fillStyle = HOSTILITY_COLOR[h] + "33";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (h === "friend") {
    ctx.arc(x, y + s * 0.4, s, Math.PI, 0);
    ctx.closePath();
  } else if (h === "hostile") {
    ctx.moveTo(x - s, y + s * 0.5);
    ctx.lineTo(x, y - s);
    ctx.lineTo(x + s, y + s * 0.5);
    ctx.closePath();
  } else if (h === "neutral") {
    ctx.rect(x - s * 0.85, y - s * 0.6, s * 1.7, s * 1.1);
  } else {
    ctx.moveTo(x - s, y + s * 0.5);
    ctx.arc(x - s * 0.5, y - s * 0.1, s * 0.5, Math.PI, Math.PI * 1.75);
    ctx.arc(x, y - s * 0.45, s * 0.5, Math.PI * 1.2, Math.PI * 1.8);
    ctx.arc(x + s * 0.5, y - s * 0.1, s * 0.5, Math.PI * 1.25, 0);
    ctx.lineTo(x + s, y + s * 0.5);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 1;
}

/** Shaded relief with contours, rendered once per scenario. */
function renderRelief(terrain: Terrain): HTMLCanvasElement {
  const N = 384;
  const c = document.createElement("canvas");
  c.width = N;
  c.height = N;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(N, N);
  const size = terrain.size;
  const step = terrain.maxH > 120 ? 50 : 15;
  const hAt = (i: number, j: number) => terrain.height(-size / 2 + ((i + 0.5) / N) * size, size / 2 - ((j + 0.5) / N) * size);
  const H: number[] = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H.push(hAt(i, j));
  const cell = size / N;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const h = H[j * N + i];
      const hx = H[j * N + Math.min(N - 1, i + 1)] - H[j * N + Math.max(0, i - 1)];
      const hy = H[Math.min(N - 1, j + 1) * N + i] - H[Math.max(0, j - 1) * N + i];
      const shade = Math.max(0.35, Math.min(1.25, 0.85 + (-hx + hy) / (cell * 2) * 2.2));
      const t = Math.min(1, h / Math.max(60, terrain.maxH));
      let r = (14 + 30 * t) * shade;
      let g = (24 + 22 * t) * shade;
      let b = (20 + 8 * t) * shade;
      const band = Math.floor(h / step);
      const right = Math.floor(H[j * N + Math.min(N - 1, i + 1)] / step);
      const down = Math.floor(H[Math.min(N - 1, j + 1) * N + i] / step);
      if (band !== right || band !== down) {
        r += 18;
        g += 22;
        b += 20;
      }
      const o = (j * N + i) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
