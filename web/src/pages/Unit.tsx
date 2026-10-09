/** Unit dashboard (PLAN.md 6.10): who is weak at what, and is the course improving. */
import { useEffect, useState } from "react";
import { DEMO, api } from "../api.ts";
import { go } from "../App.tsx";
import { ChartCard, SessionLines, Stat, VIZ } from "../charts/ChartKit.tsx";
import type { Unit, UnitDashboard } from "../types.ts";
import { STORAGE } from "../util.ts";
import { TAG_TEXT } from "./Trainee.tsx";

/** Diverging cell colour around the 1000 starting rating: red weaker, grey neutral, blue stronger. */
function cellColor(r: number): string {
  const k = Math.max(-1, Math.min(1, (r - 1000) / 150));
  const pole = k >= 0 ? VIZ.pos : VIZ.neg;
  return `color-mix(in oklab, ${pole} ${Math.round(Math.abs(k) * 100)}%, ${VIZ.mid})`;
}

export default function UnitPage({ unitId }: { unitId?: string }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [d, setD] = useState<UnitDashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const id = unitId ?? STORAGE.get("unit") ?? undefined;

  useEffect(() => {
    api.units().then((u) => {
      setUnits(u);
      if (!id && u.length) go(`unit/${u[0].id}`);
    });
  }, [id]);
  useEffect(() => {
    if (!id) return;
    STORAGE.set("unit", id);
    setD(null);
    api.unitDashboard(id).then(setD).catch((e) => setErr(String(e)));
  }, [id]);

  if (err) return <div className="page"><div className="banner warn">{err}</div></div>;
  if (!units.length) return <div className="page"><div className="empty">No units yet. Create a trainee on the Trainees page first.</div></div>;
  if (!d) return <div className="page muted">Loading…</div>;

  const skills = Object.keys(d.skill_names);
  const sessions = d.trainees.reduce((a, t) => a + t.sessions, 0);
  const recent = d.trainees.map((t) => t.recent_mean).filter((x): x is number => x !== null);
  const benchGains = d.trainees.filter((t) => t.bench_first !== null && t.bench_last !== null && t.sessions > 1).map((t) => t.bench_last! - t.bench_first!);

  return (
    <div className="page">
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <div>
          <div className="small muted">UNIT DASHBOARD</div>
          <h1 style={{ margin: 0 }}>{d.unit.name}</h1>
        </div>
        <select className="right" value={d.unit.id} onChange={(e) => go(`unit/${e.target.value}`)} aria-label="Unit">
          {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      {d.synthetic && (
        <div className="banner synthetic" style={{ marginBottom: 12 }}>
          SYNTHETIC unit: six simulated trainees (each with a different built-in weakness) flew 10 sessions each through the real loop. Use it to read the dashboard, not as evidence.
        </div>
      )}
      {DEMO && !d.synthetic && (
        <div className="banner" style={{ marginBottom: 12 }}>
          Missions flown in the preview are not scored, so this unit stays at the starting ratings. Pick the SYNTHETIC course above to see a
          filled-in dashboard.
        </div>
      )}
      <div className="tiles" style={{ marginBottom: 16 }}>
        <Stat label="Trainees" value={d.trainees.length} />
        <Stat label="Sessions scored" value={sessions} />
        <Stat label="Recent mean score" value={recent.length ? (recent.reduce((a, b) => a + b, 0) / recent.length).toFixed(0) : "-"} note="last 3 sessions per trainee" />
        <Stat
          label="Benchmark gain"
          value={benchGains.length ? `${benchGains.reduce((a, b) => a + b, 0) / benchGains.length >= 0 ? "+" : ""}${(benchGains.reduce((a, b) => a + b, 0) / benchGains.length).toFixed(0)}` : "-"}
          note="mean first → latest benchmark"
          tone={benchGains.length ? (benchGains.reduce((a, b) => a + b, 0) >= 0 ? "good" : "alert") : undefined}
        />
        <Stat label="Weakest skill (unit)" value={d.weakest_skill ?? "-"} note={d.weakest_skill ? d.skill_names[d.weakest_skill] : undefined} tone="warn" />
      </div>

      <div className="panel" style={{ marginBottom: 16, overflowX: "auto" }}>
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <div>
            <div style={{ fontWeight: 600 }}>Skill ratings by trainee</div>
            <div className="small muted">Everyone starts at 1000. Red is below the start, blue above. Click a name for that trainee's progress.</div>
          </div>
          <div className="right row small muted" style={{ gap: 6 }}>
            <span className="badge" style={{ background: cellColor(850), color: "#fff" }}>850</span>
            <span className="badge" style={{ background: cellColor(1000), color: "#fff" }}>1000</span>
            <span className="badge" style={{ background: cellColor(1150), color: "#fff" }}>1150</span>
          </div>
        </div>
        <table className="data heat">
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Trainee</th>
              {skills.map((k) => <th key={k} title={d.skill_names[k]} style={{ textAlign: "center" }}>{k}</th>)}
              <th className="num">Sessions</th>
              <th className="num">Benchmark</th>
            </tr>
          </thead>
          <tbody>
            {d.trainees.map((t) => (
              <tr key={t.id} className="click" onClick={() => go(`trainee/${t.id}`)}>
                <td style={{ textAlign: "left", fontFamily: "var(--sans)" }}>{t.rank} {t.name}</td>
                {skills.map((k) => (
                  <td key={k} className="cell" style={{ background: cellColor(t.skills[k]) }} title={`${d.skill_names[k]}: ${t.skills[k]}`}>
                    {t.skills[k]}
                  </td>
                ))}
                <td className="num">{t.sessions}</td>
                <td className="num">{t.bench_first !== null ? `${Math.round(t.bench_first)} → ${Math.round(t.bench_last ?? t.bench_first)}` : "-"}</td>
              </tr>
            ))}
            <tr>
              <td style={{ textAlign: "left", fontFamily: "var(--sans)" }} className="muted">Unit mean</td>
              {skills.map((k) => <td key={k} className="cell" style={{ background: cellColor(d.skill_means[k]) }}>{d.skill_means[k]}</td>)}
              <td /><td />
            </tr>
          </tbody>
        </table>
        <div className="small muted" style={{ marginTop: 6 }}>
          {skills.map((k) => `${k} ${d.skill_names[k]}`).join(" · ")}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)" }}>
        <ChartCard
          title="Unit learning curve"
          subtitle="mean score at each trainee's Nth session (adaptive and scripted; difficulty rises along the way)"
          table={{ columns: ["Session #", "Mean score", "Trainees"], rows: d.curve.map((c) => [c.n, c.mean_total, c.trainees]) }}
          height={240}
        >
          <SessionLines data={d.curve.map((c) => ({ n: c.n, v: c.mean_total }))} series={[{ key: "v", name: "mean score", color: VIZ.series[0] }]} yDomain={[0, 100]} />
        </ChartCard>
        <div className="panel">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Most common issues across the unit</div>
          <table className="data">
            <tbody>
              {Object.entries(d.issues).map(([k, v]) => <tr key={k}><td>{TAG_TEXT[k] ?? k}</td><td className="num">{v}</td></tr>)}
              {!Object.keys(d.issues).length && <tr><td className="faint">None yet.</td></tr>}
            </tbody>
          </table>
          {d.weakest_skill && (
            <p className="small" style={{ marginTop: 10, marginBottom: 0 }}>
              <b>Suggested unit drill:</b> {d.skill_names[d.weakest_skill]}. Generate one fixed-seed mission on the <a href="#/instructor">Instructor</a> page so the whole unit flies the same thing and can be compared fairly.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
