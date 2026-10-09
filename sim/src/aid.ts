/**
 * AI classification aid (PLAN.md 6.12).
 *
 * Features come only from what the sensors produced for a track (never
 * ground truth), so the aid is wrong in the same situations a human is:
 * degraded sensors, night, look-alikes. The model is a calibrated multinomial
 * logistic regression trained offline on synthetic tracks
 * (scripts/train_aid.py); it is small enough to run in the browser and every
 * suggestion can say why ("no RF emission", "hovering").
 *
 * "unreliable" mode is an instructor tool: for a fixed subset of tracks it
 * confidently suggests a plausible wrong class, to measure automation bias.
 */
import type { Label } from "./contracts.ts";
import { streamSeed } from "./rng.ts";
import type { Sim } from "./sim.ts";
import type { AidSuggestion, Track } from "./types.ts";
import { dot, len2, norm, v3 } from "./vec.ts";

export const AID_FEATURES = [
  "speed",
  "speed_sd",
  "agl",
  "climb_abs",
  "hover_frac",
  "rf_any",
  "rf_58",
  "rf_24",
  "rf_link",
  "ac_heard",
  "iff_friend",
  "iff_none",
  "thermal",
  "thermal_known",
  "range_km",
  "closing",
] as const;

export const AID_CLASSES: Label[] = ["bird", "friendly", "civil", "recon", "fpv", "loitering", "decoy"];

export interface AidModel {
  features: string[];
  classes: string[];
  mean: number[];
  std: number[];
  coef: number[][];
  intercept: number[];
  temperature: number;
  metrics?: Record<string, unknown>;
}

export function featuresOf(sim: Sim, tr: Track): number[] | null {
  if (tr.speedSamples.length < 3) return null;
  const n = tr.speedSamples.length;
  const mean = tr.speedSamples.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(tr.speedSamples.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const agl = tr.altSamples.reduce((a, b) => a + b, 0) / Math.max(1, tr.altSamples.length);
  const hover = tr.speedSamples.filter((s) => s < 2.5).length / n;
  const band = tr.rfBand ?? "";
  const p = sim.predicted(tr);
  let closing = 0;
  for (const a of sim.sc.map.assets) {
    const to = v3(a.pos[0] - p.x, a.pos[1] - p.y, 0);
    closing = Math.max(closing, dot(v3(tr.vel.x, tr.vel.y, 0), norm(to)));
  }
  return [
    mean,
    sd,
    agl,
    Math.abs(tr.vel.z),
    hover,
    band ? 1 : 0,
    band.includes("5.8") ? 1 : 0,
    band.includes("2.4") ? 1 : 0,
    band.toLowerCase().includes("datalink") ? 1 : 0,
    sim.t - tr.src.ac < 15 ? 1 : 0,
    tr.iff === "friend" ? 1 : 0,
    tr.iff === "no_reply" ? 1 : 0,
    tr.thermalSeen ?? 0,
    tr.thermalSeen === null ? 0 : 1,
    len2(p) / 1000,
    closing / 50,
  ];
}

const REASON: Record<string, [string, string]> = {
  // feature: [text when high, text when low]
  speed: ["fast", "slow"],
  speed_sd: ["erratic speed", "steady speed"],
  agl: ["high", "low altitude"],
  hover_frac: ["hovers", "never hovers"],
  rf_any: ["RF emitter", "no RF emission"],
  rf_58: ["5.8 GHz video link", ""],
  rf_24: ["2.4 GHz control link", ""],
  rf_link: ["encrypted datalink", ""],
  ac_heard: ["heard by acoustics", "silent to acoustics"],
  iff_friend: ["IFF: friend", ""],
  iff_none: ["no IFF reply", ""],
  thermal: ["hot in IR", "cool in IR"],
  closing: ["closing on the base", "not closing"],
};

export function predict(model: AidModel, x: number[]): { probs: number[]; contrib: number[][] } {
  const z = x.map((v, i) => (v - model.mean[i]) / (model.std[i] || 1));
  const contrib = model.coef.map((row) => row.map((w, i) => w * z[i]));
  const logits = contrib.map((c, k) => (c.reduce((a, b) => a + b, 0) + model.intercept[k]) / model.temperature);
  const m = Math.max(...logits);
  const e = logits.map((l) => Math.exp(l - m));
  const s = e.reduce((a, b) => a + b, 0);
  return { probs: e.map((v) => v / s), contrib };
}

const WRONG: Record<string, Label> = {
  bird: "recon",
  friendly: "loitering",
  civil: "recon",
  recon: "bird",
  fpv: "bird",
  loitering: "decoy",
  decoy: "loitering",
};

export function makeAid(model: AidModel, mode: "honest" | "unreliable"): (sim: Sim, tr: Track) => AidSuggestion | null {
  return (sim, tr) => {
    const x = featuresOf(sim, tr);
    if (!x) return null;
    const { probs, contrib } = predict(model, x);
    let k = probs.indexOf(Math.max(...probs));
    let label = model.classes[k] as Label;
    let p = probs[k];
    if (mode === "unreliable" && streamSeed(sim.sc.seed, tr.id) % 100 < 35) {
      // confidently wrong on a fixed third of tracks: does the trainee check, or just accept?
      label = WRONG[label] ?? label;
      k = model.classes.indexOf(label);
      p = Math.max(0.75, Math.min(0.95, 0.6 + p * 0.4));
    }
    const ranked = contrib[k]
      .map((c, i) => ({ c, f: model.features[i], v: x[i] }))
      .filter((r) => REASON[r.f] && Math.abs(r.c) > 0.15)
      .sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
    const reasons: string[] = [];
    for (const r of ranked) {
      const z = (r.v - model.mean[model.features.indexOf(r.f)]) / (model.std[model.features.indexOf(r.f)] || 1);
      const txt = REASON[r.f][z >= 0 ? 0 : 1];
      if (!txt || reasons.includes(txt)) continue;
      if (r.f === "speed") reasons.push(`${txt} (${x[0].toFixed(0)} m/s)`);
      else if ((r.f === "thermal" || r.f === "thermal_known") && x[13] === 0) continue;
      else reasons.push(txt);
      if (reasons.length === 2) break;
    }
    const probsBy: Partial<Record<Label, number>> = {};
    model.classes.forEach((c, i) => (probsBy[c as Label] = probs[i]));
    return { label, p, reasons, probs: probsBy };
  };
}
