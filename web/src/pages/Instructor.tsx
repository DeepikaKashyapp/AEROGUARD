/**
 * Instructor tools (PLAN.md 5.4): edit the scoring rule tree without code and
 * see its effect on past sessions before publishing; generate a fixed-seed
 * drill for a whole unit; inspect the classification aid's model card.
 */
import { Terrain, type AidModel, type Catalogue, type Scenario } from "@cuas/sim";
import { useEffect, useMemo, useState } from "react";
import { DEMO, api } from "../api.ts";
import type { MapModel } from "../console/mapDraw.ts";
import TacticalMap from "../console/TacticalMap.tsx";
import type { Unit } from "../types.ts";
import { CLASS_TEXT, ROE_TEXT, when } from "../util.ts";

export default function InstructorPage() {
  return (
    <div className="page col" style={{ gap: 16 }}>
      <div>
        <div className="small muted">DIRECTING STAFF</div>
        <h1 style={{ margin: 0 }}>Instructor tools</h1>
      </div>
      {DEMO && (
        <div className="banner warn">
          Preview build: re-scoring, publishing rules and generating drills run on the AEROGUARD server, so here the rules are read-only and
          the drill generator shows pre-generated examples.
        </div>
      )}
      <RulesEditor />
      <DrillGenerator />
      <AidCard />
    </div>
  );
}

function RulesEditor() {
  const [current, setCurrent] = useState<{ version: number; yaml: string; versions: { version: number; author: string; note: string; created: number }[] } | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewRules>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () =>
    api.rules().then((r) => {
      setCurrent(r);
      setText(r.yaml);
    });
  useEffect(() => {
    load();
  }, []);
  if (!current) return <div className="panel muted">Loading rules…</div>;
  const dirty = text !== current.yaml;

  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setPreview(await api.previewRules(text));
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    setBusy(true);
    try {
      const r = await api.publishRules(text, note || "edited in the instructor page");
      setMsg(`Published rules v${r.version}. New sessions are scored with it; old scores keep their version.`);
      setNote("");
      setPreview(null);
      await load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Scoring rules</h2>
        <span className="badge info">v{current.version} live</span>
        <span className="small muted">The decision tree every session is scored by. Edit, preview the effect on recent sessions, then publish.</span>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)", alignItems: "start" }}>
        <div className="col" style={{ gap: 8 }}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            aria-label="Scoring rules YAML"
            style={{ fontFamily: "var(--mono)", fontSize: 12, minHeight: 420, lineHeight: 1.45, resize: "vertical" }}
          />
          <div className="row wrap">
            <button onClick={run} disabled={busy}>Preview impact</button>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Change note (e.g. softer wasted-jam penalty)" className="grow" />
            <button className="primary" onClick={publish} disabled={busy || !dirty || !preview?.ok}>Publish v{current.version + 1}</button>
            {dirty && <button className="ghost" onClick={() => { setText(current.yaml); setPreview(null); }}>Revert</button>}
          </div>
          {msg && <div className="banner" style={{ background: "#0f2230", border: "1px solid #1d4a66" }}>{msg}</div>}
          {dirty && !preview && <div className="small muted">Preview before publishing: it re-scores recent sessions with your edit.</div>}
        </div>
        <div>
          {preview ? (
            preview.ok ? (
              <>
                <div className="row" style={{ marginBottom: 6 }}>
                  <b>Re-scored {preview.rows.length} recent sessions</b>
                  <span className={`badge ${preview.mean_change > 0 ? "good" : preview.mean_change < 0 ? "alert" : ""}`}>
                    mean change {preview.mean_change > 0 ? "+" : ""}{preview.mean_change}
                  </span>
                </div>
                <div style={{ maxHeight: 400, overflow: "auto" }}>
                  <table className="data">
                    <thead><tr><th>Trainee</th><th>Mission</th><th className="num">Now</th><th className="num">With edit</th></tr></thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={r.session}>
                          <td className="small">{r.trainee}</td>
                          <td className="small muted">{r.mission}</td>
                          <td className="num">{r.old_total.toFixed(1)} {r.old_grade}</td>
                          <td className="num" style={{ color: r.new_total > r.old_total ? "var(--good)" : r.new_total < r.old_total ? "var(--alert)" : undefined }}>
                            {r.new_total.toFixed(1)} {r.new_grade}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="banner warn" style={{ whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: 12 }}>Invalid rules: {preview.error}</div>
            )
          ) : (
            <div className="small muted">
              <p><b>How rules work.</b> Each rule has a <code>scope</code> (every engagement, once per track, or once per mission), a <code>when</code> condition over facts (e.g. <code>kind: rf_jam</code>, <code>link_in: [fiber, none]</code>, <code>cost_ratio_poor: true</code>), and a <code>then</code> with points, severity and an optional grade cap. Messages can quote facts in braces.</p>
              <h3>Version history</h3>
              <table className="data">
                <tbody>
                  {current.versions.map((v) => (
                    <tr key={v.version}><td className="mono">v{v.version}</td><td className="small">{v.note || v.author}</td><td className="small muted">{when(v.created)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const SKILL_OPTS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"];

function DrillGenerator() {
  const [names, setNames] = useState<Record<string, string>>({});
  const [units, setUnits] = useState<Unit[]>([]);
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e6));
  const [level, setLevel] = useState(0.5);
  const [focus, setFocus] = useState<string[]>(["S4"]);
  const [sc, setSc] = useState<Scenario | null>(null);
  const [unitId, setUnitId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api.skills().then(setNames);
    api.units().then((u) => {
      setUnits(u);
      setUnitId(u.find((x) => !x.synthetic)?.id ?? u[0]?.id ?? "");
    });
    api.catalogue().then(setCat);
  }, []);
  useEffect(() => {
    api.generate(seed, level, focus).then(setSc);
  }, [seed, level, focus]);
  const terrain = useMemo(
    () => (sc ? new Terrain(sc.map.terrain_seed, sc.map.terrain, sc.map.size_m, sc.map.assets.map((a) => ({ x: a.pos[0], y: a.pos[1], r: Math.max(500, a.radius_m * 4) }))) : null),
    [sc],
  );
  const issue = async () => {
    const trainees = await api.trainees(unitId);
    for (const t of trainees) await api.issue({ trainee_id: t.id, mode: "drill", seed, level, focus });
    setMsg(`Issued this drill (seed ${seed}) to ${trainees.length} trainee(s). It appears in each trainee's recent sessions as "not flown".`);
  };

  return (
    <div className="panel">
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Unit drill generator</h2>
        <span className="small muted">Same seed = same mission for everyone, so a unit can be compared fairly.</span>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", alignItems: "start" }}>
        <div className="col">
          <div className="row wrap">
            <label>Seed<input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} style={{ width: 130 }} /></label>
            <button className="sm" style={{ alignSelf: "flex-end" }} onClick={() => setSeed(Math.floor(Math.random() * 1e6))}>Random</button>
            <label className="grow">Difficulty {Math.round(level * 100)}%<input type="range" min={0} max={1} step={0.05} value={level} onChange={(e) => setLevel(Number(e.target.value))} /></label>
          </div>
          <div>
            <div className="small muted" style={{ marginBottom: 4 }}>Focus skills</div>
            <div className="row wrap" style={{ gap: 6 }}>
              {SKILL_OPTS.map((s) => (
                <button key={s} className={`sm ${focus.includes(s) ? "primary" : ""}`} onClick={() => setFocus((f) => (f.includes(s) ? f.filter((x) => x !== s) : [...f, s]))} title={names[s]}>
                  {s} {names[s]}
                </button>
              ))}
            </div>
          </div>
          {sc && (
            <div className="card">
              <b>{sc.name}</b>
              <div className="small muted" style={{ margin: "4px 0 8px" }}>
                {sc.environment.time_of_day} · {sc.environment.weather} · {ROE_TEXT[sc.roe.state]} · {Math.round(sc.duration_s / 60)} min · fingerprint {sc.fingerprint}
              </div>
              <table className="data">
                <thead><tr><th>Wave</th><th className="num">T+</th><th>Tactic</th><th className="num">Bearing</th><th>Units</th></tr></thead>
                <tbody>
                  {sc.waves.map((w) => (
                    <tr key={w.id}>
                      <td className="mono">{w.id}</td>
                      <td className="num">{Math.round(w.t)} s</td>
                      <td className="small">{w.tactic.replace(/_/g, " ")}</td>
                      <td className="num">{Math.round(w.bearing_deg)}°</td>
                      <td className="small">{w.units.map((u) => `${u.n}× ${CLASS_TEXT[u.cls]}`).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="small muted" style={{ marginTop: 6 }}>
                Sensor failures: {sc.sensors.filter((s) => s.events.length).map((s) => `${s.id} ${s.events.map((e) => `${e.state} at ${e.t}s`).join(", ")}`).join("; ") || "none"} · Birds: {sc.clutter.bird_flocks} flocks · Friendly UAVs: {sc.clutter.friendly_flights.length} · Civil drones: {sc.clutter.civil_drones}
              </div>
            </div>
          )}
          <div className="row wrap">
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)} aria-label="Unit">
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button className="primary" onClick={issue} disabled={!unitId || !sc}>Issue to every trainee in the unit</button>
          </div>
          {msg && <div className="banner" style={{ background: "#0f2230", border: "1px solid #1d4a66" }}>{msg}</div>}
        </div>
        <div className="mapwrap" style={{ height: 420, borderRadius: 6, overflow: "hidden", border: "1px solid var(--line)" }}>
          {sc && terrain && cat && <TacticalMap key={sc.fingerprint + seed} scenario={sc} terrain={terrain} getModel={() => drillModel(sc, cat)} selected={null} fitMetres={17000} />}
        </div>
      </div>
    </div>
  );
}

/** Instructor-only preview: shows where each wave comes from (trainees never see this). */
function drillModel(sc: Scenario, cat: Catalogue): MapModel {
  return {
    t: 0,
    tracks: sc.waves.map((w) => {
      const a = sc.map.assets.find((x) => x.id === w.target) ?? sc.map.assets[0];
      const r = (w.bearing_deg * Math.PI) / 180;
      return {
        id: w.id,
        x: a.pos[0] + Math.sin(r) * w.range_m,
        y: a.pos[1] + Math.cos(r) * w.range_m,
        vx: -Math.sin(r) * 30,
        vy: -Math.cos(r) * 30,
        hostility: "hostile" as const,
        label: w.tactic.replace(/_/g, " "),
        displayed: true,
        down: false,
        hooked: true,
        decision: "none",
        engaged: false,
      };
    }),
    strobes: [],
    shots: [],
    sensorsDown: [],
    camera: null,
    effectors: sc.effectors.map((f) => {
      const s = cat.effectors[f.type];
      return { id: f.id, kind: s.kind, kill: s.kill, x: f.pos[0], y: f.pos[1], range: s.range_m, status: "ready", sector: null, targetTrack: null };
    }),
  };
}

function AidCard() {
  const [m, setM] = useState<AidModel | null>(null);
  useEffect(() => {
    api.aidModel().then(setM).catch(() => setM(null));
  }, []);
  if (!m) return null;
  const mt = m.metrics as Record<string, any>;
  return (
    <div className="panel">
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>AI classification aid: model card</h2>
        <span className="small muted">Multinomial logistic regression with temperature calibration, trained on synthetic tracks from the simulator (scripts/train_aid.py).</span>
      </div>
      <div className="tiles" style={{ marginBottom: 10 }}>
        <div className="card stat-tile"><div className="l">Balanced accuracy</div><div className="v">{Math.round(mt.balanced_accuracy * 100)}%</div><div className="n">mean recall over the 7 classes</div></div>
        <div className="card stat-tile"><div className="l">Calibration error (ECE)</div><div className="v">{mt.ece}</div><div className="n">before temperature scaling: {mt.ece_before_calibration}</div></div>
        <div className="card stat-tile"><div className="l">Training data</div><div className="v">{Math.round(mt.samples / 1000)}k</div><div className="n">track samples from {mt.scenarios} synthetic missions; held-out test split by mission</div></div>
      </div>
      <table className="data">
        <thead><tr><th>Class</th>{m.classes.map((c) => <th key={c} className="num">{c}</th>)}</tr></thead>
        <tbody>
          <tr><td>Recall</td>{m.classes.map((c) => <td key={c} className="num" style={{ color: mt.recall[c] < 0.85 ? "var(--warn)" : undefined }}>{Math.round(mt.recall[c] * 100)}%</td>)}</tr>
        </tbody>
      </table>
      <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>
        Where it is weak matters for training: it confuses loitering munitions and decoys (they fly alike; only IR heat and engine noise separate them).
        Trainees should check those on the IR camera rather than trust it. Turn the aid on per session from the trainee page; the "unreliable" mode
        makes it confidently wrong on a third of tracks to measure automation bias, reported in the after-action review.
      </p>
    </div>
  );
}
