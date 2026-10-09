import { useEffect, useState } from "react";
import { DEMO, api, handoff } from "../api.ts";
import { PREVIEW_REVIEW_IDS, localResult } from "../demo/demoApi.ts";
import { go } from "../App.tsx";
import type { MissionInfo, SessionRow, Trainee, Unit } from "../types.ts";
import { ROE_TEXT, STORAGE, when } from "../util.ts";

export default function Home() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [trainees, setTrainees] = useState<Trainee[]>([]);
  const [missions, setMissions] = useState<MissionInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(STORAGE.get("trainee"));
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([api.units(), api.trainees(), api.missions()])
      .then(([u, t, m]) => {
        setUnits(u);
        setTrainees(t);
        setMissions(m);
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    refresh();
  }, []);

  const pick = (id: string | null) => {
    setSelected(id);
    STORAGE.set("trainee", id);
  };
  const trainee = trainees.find((t) => t.id === selected) ?? null;

  return (
    <div className="page">
      {error && <div className="banner warn" style={{ marginBottom: 16 }}>Cannot reach the AEROGUARD server: {error}</div>}
      <div className="grid" style={{ gridTemplateColumns: "minmax(300px, 380px) 1fr", alignItems: "start" }}>
        <TraineeList units={units} trainees={trainees} selected={selected} onPick={pick} onCreated={(t) => { refresh(); pick(t.id); }} />
        {trainee ? <TraineeHome trainee={trainee} missions={missions} /> : <Intro />}
      </div>
    </div>
  );
}

function Intro() {
  return (
    <div className="panel">
      <h1>Counter-drone decision trainer</h1>
      <p className="muted">
        AEROGUARD trains the full kill chain against drones: <b>detect</b> a track, <b>classify</b> it on the EO/IR camera,{" "}
        <b>decide</b> what to do under the rules of engagement, and <b>engage</b> with the cheapest effector that will work. Every
        decision is scored, replayed in an after-action review, and the next mission is built around your weak spots.
      </p>
      <p className="muted">Pick a trainee on the left, or create one, to begin.</p>
      <div className="grid three" style={{ marginTop: 16 }}>
        <div className="card"><h3>Realistic sensors</h3><p className="small muted">Radar drops hovering drones and sees birds; RF cannot hear fiber-optic or pre-programmed drones; EO goes blind at night.</p></div>
        <div className="card"><h3>Decision scoring</h3><p className="small muted">Rule-tree scoring of every step: detection time, classification, cost-exchange, ROE, fratricide.</p></div>
        <div className="card"><h3>Adaptive</h3><p className="small muted">A rating per skill; each new mission targets your weakest one and never repeats exactly.</p></div>
      </div>
    </div>
  );
}

function TraineeList({ units, trainees, selected, onPick, onCreated }: {
  units: Unit[];
  trainees: Trainee[];
  selected: string | null;
  onPick: (id: string) => void;
  onCreated: (t: Trainee) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [rank, setRank] = useState("Maj");
  const [unitId, setUnitId] = useState("");
  const [newUnit, setNewUnit] = useState("");
  const [busy, setBusy] = useState(false);
  const realUnits = units.filter((u) => !u.synthetic);

  const create = async () => {
    setBusy(true);
    try {
      let uid = unitId;
      if (!uid) uid = (await api.createUnit(newUnit.trim() || "DSSC course")).id;
      const t = await api.createTrainee(name.trim(), uid, rank.trim());
      setAdding(false);
      setName("");
      onCreated(t);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Trainees</h2>
        <button className="sm right" onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "+ New trainee"}</button>
      </div>
      {adding && (
        <div className="card col" style={{ marginBottom: 12 }}>
          <div className="row">
            <label style={{ width: 90 }}>Rank<input value={rank} onChange={(e) => setRank(e.target.value)} /></label>
            <label className="grow">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. A. Sharma" autoFocus /></label>
          </div>
          <label>
            Unit / course
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">New unit…</option>
              {realUnits.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          {!unitId && <label>New unit name<input value={newUnit} onChange={(e) => setNewUnit(e.target.value)} placeholder="e.g. DSSC Course 82, Syndicate 4" /></label>}
          <button className="primary" disabled={!name.trim() || busy} onClick={create}>Create trainee</button>
        </div>
      )}
      {units.map((u) => {
        const ts = trainees.filter((t) => t.unit_id === u.id);
        return (
          <div key={u.id} style={{ marginBottom: 14 }}>
            <div className="row small" style={{ marginBottom: 6 }}>
              <span className="muted">{u.name}</span>
              {!!u.synthetic && <span className="badge synthetic">SYNTHETIC</span>}
              <a className="right small" href={`#/unit/${u.id}`}>dashboard →</a>
            </div>
            <div className="col" style={{ gap: 6 }}>
              {ts.map((t) => (
                <div key={t.id} className={`card click ${t.id === selected ? "sel" : ""}`} onClick={() => onPick(t.id)}>
                  <div className="row">
                    <b>{t.rank} {t.name}</b>
                    <span className="right faint small">{t.sessions ?? 0} sessions</span>
                    {t.last_total !== null && t.last_total !== undefined && <span className="mono small">{Math.round(t.last_total)}</span>}
                  </div>
                </div>
              ))}
              {!ts.length && <div className="faint small">No trainees yet.</div>}
            </div>
          </div>
        );
      })}
      {!units.length && <div className="empty">No trainees yet. Create one to start.</div>}
    </div>
  );
}

/** Where a recent-session row leads (the preview has only some recorded reviews). */
function openTarget(s: SessionRow): string {
  if (DEMO) {
    if (localResult(s.id)?.result) return `summary/${s.id}`;
    if (s.status === "scored") return PREVIEW_REVIEW_IDS.includes(s.id) ? `aar/${s.id}` : "";
  }
  return s.status === "scored" ? `aar/${s.id}` : `briefing/${s.id}`;
}

function TraineeHome({ trainee, missions }: { trainee: Trainee; missions: MissionInfo[] }) {
  const [recent, setRecent] = useState<SessionRow[]>([]);
  const [aid, setAid] = useState<"off" | "honest" | "unreliable">("off");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.trainee(trainee.id).then((t) => setRecent(t.recent)).catch(() => setRecent([]));
  }, [trainee.id]);

  const start = async (mode: string, mission_id?: string) => {
    setBusy(mode + (mission_id ?? ""));
    setErr(null);
    try {
      const r = await api.issue({ trainee_id: trainee.id, mode, mission_id, aid_mode: aid });
      handoff.scenario = r.scenario;
      handoff.session = r.session;
      go(`briefing/${r.session.id}`);
    } catch (e) {
      setErr(String(e));
      setBusy(null);
    }
  };
  const scripted = missions.filter((m) => m.mode !== "benchmark");

  return (
    <div className="col" style={{ gap: 16 }}>
      {!!trainee.synthetic && <div className="banner synthetic">This is a SYNTHETIC trainee: a simulated learner used to demo the dashboards. Its data is not from a real person.</div>}
      <div className="panel">
        <div className="row wrap">
          <div>
            <h1 style={{ marginBottom: 2 }}>{trainee.rank} {trainee.name}</h1>
            <div className="muted small">{trainee.unit_name} · {trainee.sessions ?? 0} sessions scored</div>
          </div>
          <a className="right btn" href={`#/trainee/${trainee.id}`}>Progress &amp; trends →</a>
        </div>
        <div className="row wrap" style={{ marginTop: 16 }}>
          <button className="primary" disabled={!!busy} onClick={() => start("adaptive")}>
            {busy === "adaptive" ? "Building mission…" : "▶ Start adaptive mission"}
          </button>
          <button disabled={!!busy} onClick={() => start("benchmark")}>Benchmark B-1</button>
          <label className="right" style={{ flexDirection: "row", alignItems: "center" }}>
            AI classification aid
            <select value={aid} onChange={(e) => setAid(e.target.value as typeof aid)}>
              <option value="off">off</option>
              <option value="honest">on</option>
              <option value="unreliable">on (unreliable: instructor test)</option>
            </select>
          </label>
        </div>
        <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
          The adaptive engine picks your next mission from your skill ratings: it targets your weakest skill at a difficulty you should
          handle about 70% of the time. The benchmark is the same fixed mission for everyone; fly it every few sessions to measure progress.
        </p>
        {err && <div className="banner warn" style={{ marginTop: 10 }}>{err}</div>}
      </div>

      <div className="panel">
        <h3>Scripted missions</h3>
        <div className="grid two">
          {scripted.map((m) => (
            <div key={m.id} className="card click" onClick={() => !busy && start("mission", m.id)}>
              <div className="row">
                <b>{m.name}</b>
                {m.tags.includes("flagship") && <span className="badge info right">FLAGSHIP</span>}
              </div>
              <div className="small muted" style={{ margin: "6px 0" }}>{m.briefing.slice(0, 170)}…</div>
              <div className="row wrap small" style={{ gap: 6 }}>
                <span className="badge">{m.time_of_day}</span>
                <span className="badge">{m.weather}</span>
                <span className="badge">{ROE_TEXT[m.roe]}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Recent sessions</h3>
        {recent.length ? (
          <table className="data">
            <thead>
              <tr><th>When</th><th>Mission</th><th>Mode</th><th className="num">Score</th><th>Grade</th></tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.id} className="click" onClick={() => go(openTarget(s))} title={DEMO && openTarget(s) === "" ? "Not included in the preview" : undefined}>
                  <td className="small">{when(s.scored_at ?? s.created)}</td>
                  <td>{s.scenario_name}</td>
                  <td className="small muted">{s.mode}</td>
                  <td className="num">{s.total === null ? "-" : s.total.toFixed(1)}</td>
                  <td>
                    {s.grade ? <span className={`grade ${s.grade}`}>{s.grade}</span> : <span className="faint small">{localResult(s.id)?.result ? "summary" : "not flown"}</span>}
                    {DEMO && s.status === "scored" && !PREVIEW_REVIEW_IDS.includes(s.id) && <span className="faint small"> · not in preview</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No sessions yet. Start with the adaptive mission: the first one is a gentle daylight familiarisation.</div>
        )}
      </div>
    </div>
  );
}
