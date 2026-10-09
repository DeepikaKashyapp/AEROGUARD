import { Terrain, type Catalogue, type Scenario } from "@cuas/sim";
import { useEffect, useMemo, useState } from "react";
import { api, handoff } from "../api.ts";
import { go } from "../App.tsx";
import type { MapModel } from "../console/mapDraw.ts";
import TacticalMap from "../console/TacticalMap.tsx";
import type { SessionRow } from "../types.ts";
import { KIND_TEXT, ROE_TEXT, inr } from "../util.ts";

const ROE_EXPLAIN: Record<string, string> = {
  weapons_free: "Engage any track you judge hostile.",
  weapons_tight: "Hard kill only on a POSITIVELY IDENTIFIED hostile: classify before you fire.",
  weapons_hold: "No hard kill without authority: request it (A) and wait for it to be granted.",
};

export default function Briefing({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<{ session: SessionRow; scenario: Scenario } | null>(null);
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.catalogue().then(setCat).catch((e) => setErr(String(e)));
    if (handoff.session?.id === sessionId && handoff.scenario) {
      setData({ session: handoff.session, scenario: handoff.scenario });
      return;
    }
    api
      .session(sessionId)
      .then((b) => {
        if (b.session.status === "scored") go(`aar/${sessionId}`);
        else {
          handoff.session = b.session;
          handoff.scenario = b.scenario;
          setData({ session: b.session, scenario: b.scenario });
        }
      })
      .catch((e) => setErr(String(e)));
  }, [sessionId]);

  const terrain = useMemo(
    () =>
      data
        ? new Terrain(
            data.scenario.map.terrain_seed,
            data.scenario.map.terrain,
            data.scenario.map.size_m,
            data.scenario.map.assets.map((a) => ({ x: a.pos[0], y: a.pos[1], r: Math.max(500, a.radius_m * 4) })),
          )
        : null,
    [data],
  );

  if (err) return <div className="page"><div className="banner warn">{err}</div></div>;
  if (!data || !cat || !terrain) return <div className="page muted">Loading briefing…</div>;
  const { scenario: sc, session } = data;

  const model: MapModel = {
    t: 0,
    tracks: [],
    strobes: [],
    shots: [],
    sensorsDown: [],
    camera: null,
    effectors: sc.effectors.map((f) => {
      const spec = cat.effectors[f.type];
      return { id: f.id, kind: spec.kind, kill: spec.kill, x: f.pos[0], y: f.pos[1], range: spec.range_m, status: "ready", sector: null, targetTrack: null };
    }),
  };

  return (
    <div className="page">
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <div>
          <div className="small muted">{session.mode === "adaptive" ? "ADAPTIVE MISSION" : session.mode === "benchmark" ? "BENCHMARK" : "SCRIPTED MISSION"} · BRIEFING</div>
          <h1 style={{ margin: 0 }}>{sc.name}</h1>
        </div>
        <button className="primary right" onClick={() => go(`mission/${session.id}`)}>Begin mission →</button>
      </div>
      {session.plan?.why && (
        <div className="banner" style={{ background: "#0f2230", border: "1px solid #1d4a66", marginBottom: 16 }}>
          <b>Why this mission:</b> {session.plan.why}
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)", alignItems: "start" }}>
        <div className="col" style={{ gap: 16 }}>
          <div className="panel">
            <h3>Situation</h3>
            <p>{sc.briefing}</p>
            {sc.intel && (
              <>
                <h3>Intelligence</h3>
                <p>{sc.intel}</p>
              </>
            )}
            <dl className="kv">
              <dt>Time</dt><dd>{sc.environment.time_of_day}</dd>
              <dt>Weather</dt><dd>{sc.environment.weather}</dd>
              <dt>Rules of engagement</dt><dd><b>{ROE_TEXT[sc.roe.state]}</b>: {ROE_EXPLAIN[sc.roe.state]}</dd>
              <dt>Defend</dt><dd>{sc.map.assets.map((a) => a.name).join(", ")}</dd>
              {sc.map.no_fire_zones.length > 0 && (<><dt>No-fire zones</dt><dd>{sc.map.no_fire_zones.map((z) => z.name).join(", ")}: no guns or rockets over them</dd></>)}
              {sc.clutter.friendly_flights.length > 0 && (<><dt>Own aircraft</dt><dd>{sc.clutter.friendly_flights.length} friendly UAV(s) on {sc.map.corridors.map((c) => c.name).join(", ")}</dd></>)}
            </dl>
          </div>
          <div className="panel">
            <h3>Effectors available</h3>
            <table className="data">
              <thead><tr><th>ID</th><th>System</th><th>Type</th><th className="num">Range</th><th className="num">Cost / use</th><th className="num">Ammo</th></tr></thead>
              <tbody>
                {sc.effectors.map((f) => {
                  const s = cat.effectors[f.type];
                  return (
                    <tr key={f.id}>
                      <td className="mono">{f.id}</td>
                      <td>{s.name}{s.illustrative ? "" : " *"}</td>
                      <td className="small">{KIND_TEXT[s.kind]} <span className="faint">({s.kill} kill)</span></td>
                      <td className="num">{(s.range_m / 1000).toFixed(2)} km</td>
                      <td className="num">{inr(s.cost_inr * (s.kill === "soft" ? 1 : s.rounds_per_shot))}</td>
                      <td className="num">{f.ammo ?? s.ammo ?? "∞"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="small faint" style={{ marginTop: 8, marginBottom: 0 }}>
              * figure from the problem statement. All other figures are illustrative training values, not real performance data.
            </p>
          </div>
        </div>
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ position: "relative", height: 520 }} className="mapwrap">
            <TacticalMap scenario={sc} terrain={terrain} getModel={() => model} selected={null} showRanges fitMetres={11000} />
          </div>
          <div className="small muted" style={{ padding: "8px 12px" }}>
            Defended area with effector ranges. Drag to pan, scroll to zoom.
          </div>
        </div>
      </div>
    </div>
  );
}
