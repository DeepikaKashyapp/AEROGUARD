/**
 * The C2 console (PLAN.md 3.1): tactical display, track table, EO/IR camera,
 * track panel, effectors, event feed. Runs the sim in the browser at a fixed
 * 20 Hz step, renders at the display's frame rate, and posts the event log
 * to the server for scoring when the mission ends.
 */
import { DT, Sim, type AidFn, type Label, type Scenario, type SimView, type TrackView } from "@cuas/sim";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, handoff } from "../api.ts";
import { go } from "../App.tsx";
import CameraView from "../console/CameraView.tsx";
import EffectorPanel, { effectorKeys } from "../console/EffectorPanel.tsx";
import type { MapModel } from "../console/mapDraw.ts";
import TacticalMap from "../console/TacticalMap.tsx";
import TrackPanel, { LABEL_KEYS } from "../console/TrackPanel.tsx";
import TrackTable, { sortTracks } from "../console/TrackTable.tsx";
import { loadAid } from "../aid.ts";
import type { SessionRow } from "../types.ts";
import { ROE_TEXT, clock, inr } from "../util.ts";

const SENSOR_SHORT: Record<string, string> = { radar: "RDR", rf: "RF", acoustic: "ACS", eoir: "CAM", iff: "IFF" };

export default function Mission({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<{ sim: Sim; session: SessionRow } | { error: string } | null>(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        let scenario: Scenario;
        let session: SessionRow;
        if (handoff.session?.id === sessionId && handoff.scenario) {
          scenario = handoff.scenario;
          session = handoff.session;
        } else {
          const b = await api.session(sessionId);
          if (b.session.status === "scored") return go(`aar/${sessionId}`);
          scenario = b.scenario;
          session = b.session;
        }
        const catalogue = await api.catalogue();
        const aidMode = (session.aid_mode as "off" | "honest" | "unreliable") ?? "off";
        let aid: AidFn | undefined;
        if (aidMode !== "off") aid = await loadAid(aidMode);
        const sim = new Sim({ scenario, catalogue, actor: "trainee", aidMode, aid });
        if (import.meta.env.DEV) (window as unknown as { __sim: Sim }).__sim = sim; // for automated browser tests
        if (!dead) setState({ sim, session });
      } catch (e) {
        if (!dead) setState({ error: String(e) });
      }
    })();
    return () => {
      dead = true;
    };
  }, [sessionId]);

  if (!state) return <div className="page muted">Loading mission…</div>;
  if ("error" in state) return <div className="page"><div className="banner warn">{state.error}</div></div>;
  return <Console sim={state.sim} session={state.session} />;
}

function Console({ sim, session }: { sim: Sim; session: SessionRow }) {
  const [view, setView] = useState<SimView>(() => sim.view());
  const [selected, setSelected] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: "warn" | "info" } | null>(null);
  const [hoverEff, setHoverEff] = useState<string | null>(null);
  const [showRanges, setShowRanges] = useState(false);
  const [phase, setPhase] = useState<"run" | "submitting" | "error">("run");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const sel = useRef<string | null>(null);
  sel.current = selected;
  const viewRef = useRef(view);
  viewRef.current = view;

  const flash = useCallback((text: string, kind: "warn" | "info" = "warn") => {
    setToast({ text, kind });
    window.clearTimeout((flash as unknown as { t?: number }).t);
    (flash as unknown as { t?: number }).t = window.setTimeout(() => setToast(null), 2200);
  }, []);

  // ---- main loop ----------------------------------------------------------
  // ?speed=N compresses time for demos and automated browser tests (never in assessed use)
  const speed = useMemo(() => Math.max(1, Math.min(16, Number(new URLSearchParams(location.search).get("speed") ?? "1") || 1)), []);
  useEffect(() => {
    if (!started) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastUi = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (!sim.paused && !sim.ended) {
        acc += dt * speed;
        let steps = 0;
        while (acc >= DT && steps < 10 * speed) {
          sim.step();
          acc -= DT;
          steps++;
        }
      }
      if (now - lastUi > 100 || sim.ended) {
        lastUi = now;
        setView(sim.view());
      }
      if (!sim.ended) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sim, started, speed]);

  // ---- submit when the mission ends ----------------------------------------
  useEffect(() => {
    if (!view.ended || phase !== "run") return;
    setPhase("submitting");
    api
      .submit(session.id, sim.result())
      .then(() => go(`aar/${session.id}`))
      .catch((e) => {
        setSubmitError(String(e));
        setPhase("error");
      });
  }, [view.ended, phase, session.id, sim]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!sim.ended) e.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [sim]);

  // ---- commands ---------------------------------------------------------------
  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      if (id) sim.hook(id);
    },
    [sim],
  );
  const track = view.tracks.find((t) => t.id === selected) ?? null;
  const classify = (l: Label, viaAid = false) => track && sim.classify(track.id, l, { viaAid });
  const decide = (d: "ignore" | "monitor") => track && sim.decide(track.id, d);
  const engage = (eff: string) => {
    if (!track) return flash("Select a track first");
    const r = sim.engage(track.id, eff);
    if (!r.ok) flash(`${eff}: ${r.reason}`);
  };
  const cue = () => {
    if (!track) return;
    const r = sim.cameraCue(track.id);
    if (!r.ok) flash(r.reason ?? "cannot cue");
  };

  // ---- hotkeys ----------------------------------------------------------------
  const keys = useMemo(() => effectorKeys(view.effectors), [view.effectors]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toUpperCase();
      const v = viewRef.current;
      const t = v.tracks.find((x) => x.id === sel.current) ?? null;
      if (!started) {
        if (k === " " || k === "ENTER") {
          e.preventDefault();
          setStarted(true);
        }
        return;
      }
      if (k === " ") {
        e.preventDefault();
        if (sim.paused) sim.resume();
        else sim.pause();
        setPaused(sim.paused);
        return;
      }
      if (k === "?" || k === "H") return setHelp((h) => !h);
      if (k === "ESCAPE") return select(null);
      if (k === "N" || k === "TAB") {
        e.preventDefault();
        const order = sortTracks(v.tracks).filter((x) => x.displayed && !x.down);
        const fresh = order.filter((x) => !x.hooked);
        const pool = fresh.length ? fresh : order;
        if (!pool.length) return;
        const i = pool.findIndex((x) => x.id === sel.current);
        return select(pool[(i + 1) % pool.length].id);
      }
      if (k === "T") return sim.cameraMode(sim.camera.mode === "ir" ? "eo" : "ir");
      if (k === "V") {
        const r = sim.cameraTrackCentre();
        flash(r.ok ? `Camera locked ${r.track}` : `Camera: ${r.reason}`, r.ok ? "info" : "warn");
        if (r.ok && r.track) select(r.track);
        return;
      }
      if (k === "+" || k === "=") return sim.cameraZoom(sim.camera.fov * 0.6);
      if (k === "-" || k === "_") return sim.cameraZoom(sim.camera.fov / 0.6);
      if (k === "R") return setShowRanges((s) => !s);
      if (!t) return;
      const label = LABEL_KEYS.find(([, key]) => key === k);
      if (label) return void sim.classify(t.id, label[0]);
      if (k === "C") {
        const r = sim.cameraCue(t.id);
        if (!r.ok) flash(r.reason ?? "cannot cue");
        return;
      }
      if (k === "M") return void sim.decide(t.id, "monitor");
      if (k === "I") return void sim.decide(t.id, "ignore");
      if (k === "A") return void sim.requestAuthority(t.id);
      for (const [id, key] of keys) {
        if (key === k) {
          const r = sim.engage(t.id, id);
          if (!r.ok) flash(`${id}: ${r.reason}`);
          return;
        }
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [sim, keys, started, select, flash]);

  // ---- map model (called every animation frame) ---------------------------------
  const getModel = useCallback((): MapModel => {
    const v = sim.view();
    return {
      t: v.t,
      tracks: v.tracks.map((t: TrackView) => ({ ...t, engaged: t.engagedBy.length > 0 })),
      strobes: v.strobes,
      effectors: v.effectors,
      shots: v.shots,
      sensorsDown: v.sensors.filter((s) => s.status === "down").map((s) => s.name),
      camera: sim.cameraAvailable() ? { x: sim.cameraPos().x, y: sim.cameraPos().y, az: sim.camera.az, fov: sim.camera.fov } : null,
    };
  }, [sim]);

  const sc = sim.sc;

  return (
    <div className="console">
      <div className="console-head">
        <b style={{ letterSpacing: "0.14em" }}>AEROGUARD</b>
        <span className="muted">{sc.name}</span>
        <span className="clock">{clock(view.t)}</span>
        <span className="faint mono">/ {clock(view.duration)}</span>
        <span className={`badge ${view.roe === "weapons_free" ? "good" : view.roe === "weapons_hold" ? "alert" : "warn"}`}>{ROE_TEXT[view.roe]}</span>
        <span className="badge">{sc.environment.time_of_day.toUpperCase()} · {sc.environment.weather.toUpperCase()}</span>
        <span className="row" style={{ gap: 3 }}>
          {view.sensors.map((s) => (
            <span key={s.id} className={`badge ${s.status === "ok" ? "" : s.status === "down" ? "alert" : "warn"}`} title={`${s.name}: ${s.status}`}>
              {SENSOR_SHORT[s.type] ?? s.type}{s.status === "ok" ? "" : s.status === "down" ? " ✕" : " ⚠"}
            </span>
          ))}
        </span>
        <span className="right" />
        {view.assets.map((a) => (
          <span key={a.id} className={`badge ${a.health >= 99 ? "good" : a.health > 40 ? "warn" : "alert"}`} title={a.name}>
            {a.name.split(" ")[0]} {Math.round(a.health)}%
          </span>
        ))}
        <span className="badge info" title="Total spent on engagements">{inr(view.spend)}</span>
        {speed !== 1 && <span className="badge warn" title="Dev time compression (?speed=)">×{speed}</span>}
        <button className="sm" onClick={() => { if (sim.paused) sim.resume(); else sim.pause(); setPaused(sim.paused); }}>{paused ? "Resume" : "Pause"}</button>
        <button className="sm" onClick={() => setHelp((h) => !h)} title="Keys">?</button>
        <button className="sm danger" onClick={() => { if (confirm("End the mission now? It will be scored as aborted.")) sim.abort(); setView(sim.view()); }}>End</button>
      </div>
      <div className="console-body">
        <div className="console-left">
          <div className="mapwrap">
            <TacticalMap
              scenario={sc}
              terrain={sim.terrain}
              getModel={getModel}
              selected={selected}
              onSelect={select}
              showRanges={showRanges}
              highlightEffector={hoverEff}
            />
            <div className="map-legend">
              <span style={{ color: "var(--unknown)" }}>■ unknown</span>
              <span style={{ color: "var(--hostile)" }}>▲ hostile</span>
              <span style={{ color: "var(--friend)" }}>● friend</span>
              <span style={{ color: "var(--neutral)" }}>■ neutral</span>
              <span style={{ color: "var(--rf)" }}>- - RF strobe</span>
              <span style={{ color: "var(--ac)" }}>··· acoustic</span>
            </div>
            <div className="map-tools">
              <button className="sm" onClick={() => setShowRanges((s) => !s)}>{showRanges ? "Hide" : "Show"} ranges <kbd>R</kbd></button>
            </div>
          </div>
          <TrackTable tracks={view.tracks} selected={selected} onSelect={select} />
        </div>
        <div className="console-right">
          <CameraView sim={sim} />
          <TrackPanel
            track={track}
            roe={view.roe}
            aidOn={sim.aidMode !== "off"}
            onClassify={classify}
            onDecide={decide}
            onAuthority={() => track && sim.requestAuthority(track.id)}
            onCue={cue}
          />
          <div style={{ display: "grid", gridTemplateRows: "minmax(0,1fr) auto", minHeight: 0 }}>
            <EffectorPanel sim={sim} effectors={view.effectors} track={track} onEngage={engage} onCease={(id) => sim.cease(id)} onHover={setHoverEff} />
            <div className="feed" aria-live="polite">
              {view.feed.slice(-14).reverse().map((f, i) => (
                <div key={`${f.t}-${i}`} className={f.level}>
                  <span className="t">{clock(f.t)}</span>
                  {f.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      {!started && (
        <div className="overlay">
          <div className="box">
            <h2>{sc.name}</h2>
            <p className="muted">{ROE_TEXT[sc.roe.state]} · {sc.environment.time_of_day} · {sc.environment.weather}</p>
            <p className="small muted">Defend: {sc.map.assets.map((a) => a.name).join(", ")}.</p>
            <button className="primary" onClick={() => setStarted(true)} autoFocus>Start mission <kbd>Space</kbd></button>
            <p className="small faint" style={{ marginTop: 12 }}>Press <kbd>?</kbd> at any time for the key list.</p>
          </div>
        </div>
      )}
      {help && <HelpOverlay onClose={() => setHelp(false)} />}
      {phase !== "run" && (
        <div className="overlay">
          <div className="box">
            {phase === "submitting" ? (
              <>
                <h2>{view.endReason === "aborted" ? "Mission ended" : view.endReason === "time_up" ? "Time up" : "All threats resolved"}</h2>
                <p className="muted">Scoring every decision…</p>
              </>
            ) : (
              <>
                <h2>Could not submit</h2>
                <p className="small">{submitError}</p>
                <button onClick={() => setPhase("run")}>Retry</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["N / Tab", "next new (unhooked) track"],
    ["click map / table", "select (hook) a track"],
    ["C", "cue the camera to the selected track"],
    ["click in camera / V", "lock the turret on what you clicked / on what is nearest the crosshair (laser rangefinder)"],
    ["T", "toggle EO / IR"],
    ["+ / − or wheel", "zoom the camera"],
    ["drag camera", "slew manually"],
    ["1–7, 0", "classify: bird, friendly, civil, recon, FPV, loitering munition, decoy, unknown"],
    ["M / I", "monitor / ignore"],
    ["A", "request authority (weapons hold)"],
    ["J G L K X S U Y", "engage with jammer, GNSS spoof, laser, rockets, missile, SAM, gun, 2nd gun"],
    ["click an active effector", "cease"],
    ["R", "show effector ranges"],
    ["Space", "pause / resume (logged)"],
  ];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="box" style={{ maxWidth: 620, textAlign: "left" }}>
        <h2>Keys</h2>
        <table className="data">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td className="mono" style={{ whiteSpace: "nowrap" }}>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted" style={{ marginTop: 10 }}>
          The kill chain: <b>Detect</b> (hook new tracks fast) → <b>Classify</b> (look at it on the camera; check RF, IFF, speed) →{" "}
          <b>Decide</b> (ignore, monitor, soft or hard kill, under the ROE) → <b>Engage</b> with the cheapest effector that will work.
        </p>
      </div>
    </div>
  );
}
