import { Terrain, type Catalogue, type SimEvent } from "@cuas/sim";
import { useEffect, useMemo, useRef, useState } from "react";
import TacticalMap from "../console/TacticalMap.tsx";
import type { Report, SessionBundle } from "../types.ts";
import { CLASS_TEXT, LABEL_TEXT, clock, inr } from "../util.ts";
import { ReplayModel } from "./replayModel.ts";

const MARK: Record<string, string> = {
  engage_order: "#ffb020",
  neutralised: "#3fd08f",
  link_lost: "#3fd08f",
  diverted: "#3fd08f",
  leaker: "#ff5252",
  collateral: "#ff5252",
  friendly_affected: "#ff5252",
  recon_complete: "#ff9a3c",
};

export interface ReplayHandle {
  seek: (t: number) => void;
}

export default function Replay({ bundle, catalogue, report, onReady }: { bundle: SessionBundle; catalogue: Catalogue; report: Report; onReady?: (h: ReplayHandle) => void }) {
  const model = useMemo(() => new ReplayModel(bundle, catalogue), [bundle, catalogue]);
  const terrain = useMemo(() => {
    const m = bundle.scenario.map;
    return new Terrain(m.terrain_seed, m.terrain, m.size_m, m.assets.map((a) => ({ x: a.pos[0], y: a.pos[1], r: Math.max(500, a.radius_m * 4) })));
  }, [bundle]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(8);
  const [truth, setTruth] = useState(false);
  const tRef = useRef(0);
  tRef.current = t;
  const truthRef = useRef(truth);
  truthRef.current = truth;

  useEffect(() => onReady?.({ seek: (x) => { setT(Math.max(0, Math.min(model.duration, x))); setPlaying(false); } }), [model, onReady]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((x) => {
        const n = x + dt * speed;
        if (n >= model.duration) {
          setPlaying(false);
          return model.duration;
        }
        return n;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, model]);

  const truthByTrack = useMemo(() => new Map(report.tracks.filter((x) => x.track).map((x) => [x.track!, x])), [report]);
  const effName = useMemo(() => new Map(bundle.scenario.effectors.map((f) => [f.id, catalogue.effectors[f.type]?.name ?? f.id])), [bundle, catalogue]);
  const events = useMemo(() => (bundle.events ?? []).filter((e) => describe(e, truthByTrack, effName) !== null), [bundle, truthByTrack, effName]);
  const marks = useMemo(() => events.filter((e) => MARK[e.type]), [events]);
  const recent = events.filter((e) => e.t <= t).slice(-9).reverse();
  const D = Math.max(1, model.duration);

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    setT(Math.max(0, Math.min(D, ((e.clientX - b.left) / b.width) * D)));
  };

  return (
    <div className="panel">
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Replay</h2>
        <button className="sm" onClick={() => { if (t >= D) setT(0); setPlaying((p) => !p); }}>{playing ? "❚❚ Pause" : "▶ Play"}</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
          {[1, 4, 8, 16].map((s) => <option key={s} value={s}>×{s}</option>)}
        </select>
        <span className="mono">{clock(t)} / {clock(D)}</span>
        <label className="right" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={truth} onChange={(e) => setTruth(e.target.checked)} /> Show ground truth
        </label>
      </div>
      <div
        className="timeline"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
        onPointerMove={(e) => { if (e.buttons) scrub(e); }}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={D}
        aria-valuenow={Math.round(t)}
        aria-label="Replay time"
      >
        {report.hesitation.map((h, i) => (
          <div key={i} className="band" style={{ left: `${(h.from / D) * 100}%`, width: `${Math.max(0.3, ((h.to - h.from) / D) * 100)}%` }} title={`${h.track ?? "?"}: real threat on the display with no action`} />
        ))}
        {marks.map((e, i) => (
          <div key={i} className="mark" style={{ left: `${(e.t / D) * 100}%`, background: MARK[e.type], opacity: 0.85 }} title={`${clock(e.t)} ${describe(e, truthByTrack, effName)}`} />
        ))}
        <div className="head" style={{ left: `${(t / D) * 100}%` }} />
      </div>
      <div className="row small muted" style={{ gap: 14, margin: "6px 0 10px" }}>
        <span><span style={{ color: "#ff5252" }}>▮</span> hesitation: a real threat on the display, nobody acting</span>
        <span><span style={{ color: "#ffb020" }}>▮</span> engagement</span>
        <span><span style={{ color: "#3fd08f" }}>▮</span> threat stopped</span>
        <span><span style={{ color: "#ff5252" }}>▮</span> leak / collateral / own drone hit</span>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px" }}>
        <div className="mapwrap" style={{ height: 520, borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)" }}>
          <TacticalMap scenario={bundle.scenario} terrain={terrain} getModel={() => model.at(tRef.current, truthRef.current)} selected={null} fitMetres={12000} />
        </div>
        <div className="col" style={{ gap: 6, maxHeight: 520, overflow: "auto" }}>
          <h3 style={{ margin: 0 }}>What happened</h3>
          {recent.map((e, i) => (
            <div key={i} className="small" style={{ cursor: "pointer" }} onClick={() => setT(e.t)}>
              <span className="mono faint">{clock(e.t)}</span> {describe(e, truthByTrack, effName)}
            </div>
          ))}
          {!recent.length && <div className="small faint">Press play, or click the timeline.</div>}
          {truth && (
            <div className="small faint" style={{ marginTop: 8 }}>
              Ground-truth dots: <span style={{ color: "#ff5252" }}>FPV</span>, <span style={{ color: "#ff2d6f" }}>fiber FPV</span>,{" "}
              <span style={{ color: "#ff4dd2" }}>loitering munition</span>, <span style={{ color: "#c7a6ff" }}>decoy</span>,{" "}
              <span style={{ color: "#ff9a3c" }}>recon</span>, <span style={{ color: "#59a8ff" }}>friendly</span>, <span style={{ color: "#4cd387" }}>bird</span>.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function describe(e: SimEvent, truth: Map<string, { true_class: string }>, effName: Map<string, string>): string | null {
  const tr = e.track ?? "untracked drone";
  const cls = e.track && truth.get(e.track) ? ` (${CLASS_TEXT[truth.get(e.track)!.true_class] ?? ""})` : "";
  const d = e.data as Record<string, unknown>;
  const eff = (id: unknown) => effName.get(String(id)) ?? String(id);
  switch (e.type) {
    case "track_new":
      return `${tr}${cls} appeared on the display`;
    case "hook":
      return `${tr} hooked (${Number(d.latency).toFixed(1)} s after it appeared)`;
    case "classify":
      return `${tr} classified ${LABEL_TEXT[String(d.label)] ?? d.label}${d.via_aid ? " (accepted AI aid)" : ""}`;
    case "decision":
      return `${tr} marked '${d.decision}'`;
    case "engage_order":
      return `${tr}${cls} ← ${eff(d.effector)}`;
    case "engage_blocked":
      return `${eff(d.effector)} could not engage ${tr}: ${d.reason}`;
    case "engage_result":
      return `${eff(d.effector)} → ${String(d.result).replace("_", " ")} (${inr(Number(d.spent))})`;
    case "neutralised":
      return `${tr}${cls} destroyed by ${eff(d.effector)}${d.friendly ? " (OWN DRONE)" : ""}`;
    case "link_lost":
      return `${tr}${cls} lost its link (jammed)`;
    case "diverted":
      return `${tr}${cls} spoofed off course`;
    case "leaker":
      return d.damage ? `${tr}${cls} HIT ${d.asset}` : `${tr}${cls} got through (missed)`;
    case "recon_complete":
      return `${tr}${cls} finished its recon orbit`;
    case "collateral":
      return `${eff(d.effector)} fired over a no-fire zone`;
    case "friendly_affected":
      return `Own/civil drone affected: ${d.effect}`;
    case "sensor_state":
      return `Sensor ${d.sensor} ${String(d.state).toUpperCase()}`;
    case "authority_request":
      return `${tr}: authority requested`;
    case "authority_granted":
      return `${tr}: authority granted`;
    case "camera_designate":
      return `Camera locked ${tr}${d.new ? " (new track from the camera)" : ""}`;
    case "pause":
      return "Paused";
    case "resume":
      return "Resumed";
    case "session_end":
      return `Mission ended (${String(d.reason).replace("_", " ")})`;
    default:
      return null;
  }
}
