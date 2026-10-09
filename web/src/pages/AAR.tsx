/**
 * After-action review (PLAN.md 6.10): report card, replay with hesitation
 * bands, a decision path per track with the rule behind every point, the
 * debrief, and what the adaptive engine learned.
 */
import type { Catalogue } from "@cuas/sim";
import { useCallback, useEffect, useRef, useState } from "react";
import Replay, { type ReplayHandle } from "../aar/Replay.tsx";
import { api, handoff } from "../api.ts";
import { go } from "../App.tsx";
import { Stat } from "../charts/ChartKit.tsx";
import type { Debrief, Hit, Report, SessionBundle, TrackReport } from "../types.ts";
import { CLASS_TEXT, clock, inr, pct, when } from "../util.ts";

export default function AARPage({ sessionId }: { sessionId: string }) {
  const [bundle, setBundle] = useState<SessionBundle | null>(null);
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [skills, setSkills] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const replay = useRef<ReplayHandle | null>(null);
  const onReady = useCallback((h: ReplayHandle) => {
    replay.current = h;
  }, []);
  const seek = (t: number | null) => {
    if (t === null) return;
    replay.current?.seek(Math.max(0, t - 3));
    document.getElementById("replay")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    Promise.all([api.session(sessionId), api.catalogue(), api.skills()])
      .then(([b, c, s]) => {
        if (b.session.status !== "scored") return go(`briefing/${sessionId}`);
        setBundle(b);
        setCat(c);
        setSkills(s);
      })
      .catch((e) => setErr(String(e)));
  }, [sessionId]);

  if (err) return <div className="page"><div className="banner warn">{err}</div></div>;
  if (!bundle || !cat || !bundle.report) return <div className="page muted">Loading after-action review…</div>;
  const r = bundle.report;
  const s = bundle.session;
  const m = r.metrics;
  const synthetic = !!bundle.trainee?.synthetic;

  const next = async (mode: string) => {
    const res = await api.issue({
      trainee_id: s.trainee_id,
      mode,
      mission_id: mode === "mission" ? (s.mission_id ?? undefined) : undefined,
      aid_mode: s.aid_mode,
    });
    handoff.scenario = res.scenario;
    handoff.session = res.session;
    go(`briefing/${res.session.id}`);
  };

  return (
    <div className="page">
      {synthetic && (
        <div className="banner synthetic" style={{ marginBottom: 12 }}>
          SYNTHETIC session: flown by a simulated trainee to demo the review. Not a real person's performance.
        </div>
      )}
      <div className="row wrap" style={{ alignItems: "flex-start", marginBottom: 16 }}>
        <span className={`grade big ${r.grade}`}>{r.grade}</span>
        <div>
          <div className="small muted">
            AFTER-ACTION REVIEW · {bundle.trainee?.rank} {bundle.trainee?.name} · {when(s.scored_at)}
          </div>
          <h1 style={{ margin: "2px 0" }}>{bundle.scenario.name}</h1>
          <div className="muted">
            <b className="mono" style={{ color: "var(--text)" }}>{r.total.toFixed(1)}</b> / 100 · {bundle.scenario.environment.time_of_day},{" "}
            {bundle.scenario.environment.weather} · {s.mode} mission · scored with rules v{r.rules_version}
            {r.capped_by.length > 0 && (
              <span className="badge alert" style={{ marginLeft: 8 }}>
                grade capped: {[...new Set(r.capped_by)].join(", ")}
              </span>
            )}
          </div>
        </div>
        <div className="right row wrap">
          <button className="primary" onClick={() => next("adaptive")}>Next adaptive mission →</button>
          {s.mission_id && s.mode !== "adaptive" && (
            <button onClick={() => next(s.mode === "benchmark" ? "benchmark" : "mission")}>Fly again</button>
          )}
          <a className="btn" href={`#/trainee/${s.trainee_id}`}>Trends</a>
        </div>
      </div>

      <div className="tiles" style={{ marginBottom: 10 }}>
        <Stat label="Detect" value={fmtStage(r.stages.detect)} note="how fast threats were hooked" tone={tone(r.stages.detect)} />
        <Stat label="Classify" value={fmtStage(r.stages.classify)} note="what you called it vs what it was" tone={tone(r.stages.classify)} />
        <Stat label="Decide & engage" value={fmtStage(r.stages.decide_engage)} note="effector choice, ROE, cost" tone={tone(r.stages.decide_engage)} />
        <Stat label="Outcome" value={fmtStage(r.stages.outcome)} note="defended assets' health" tone={tone(r.stages.outcome)} />
      </div>
      <div className="tiles" style={{ marginBottom: 16 }}>
        <Stat
          label="Threats stopped"
          value={`${m.hostile_neutralised} / ${m.hostile_total}`}
          note={`${m.leakers} got through`}
          tone={m.leakers ? "alert" : "good"}
        />
        <Stat
          label="Spent"
          value={inr(m.spent_total)}
          note={m.cost_exchange_ratio !== null ? `${m.cost_exchange_ratio}× the value of drones stopped` : "nothing stopped"}
        />
        <Stat label="Median detection time" value={m.detect_latency_median === null ? "-" : `${m.detect_latency_median} s`} note="target: under 4 s" />
        <Stat label="Classification accuracy" value={pct(m.classification_accuracy)} />
        <Stat
          label="Fratricide · ROE · collateral"
          value={`${m.fratricides} · ${m.roe_violations} · ${m.collateral}`}
          tone={m.fratricides ? "alert" : m.roe_violations || m.collateral ? "warn" : undefined}
        />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)", alignItems: "start", marginBottom: 16 }}>
        <DebriefPanel sessionId={sessionId} onSeek={seek} />
        <SkillPanel report={r} names={skills} />
      </div>

      <div id="replay" style={{ marginBottom: 16 }}>
        {bundle.replay ? <Replay bundle={bundle} catalogue={cat} report={r} onReady={onReady} /> : <div className="empty">No replay recorded.</div>}
      </div>

      <DecisionPaths report={r} onSeek={seek} />
      <RuleHits hits={[...r.mission_hits, ...r.hits]} />
    </div>
  );
}

const fmtStage = (v: number | null | undefined) => (v === null || v === undefined ? "-" : Math.round(v));
const tone = (v: number | null | undefined) =>
  v === null || v === undefined ? undefined : v >= 85 ? "good" : v >= 55 ? undefined : v >= 40 ? "warn" : "alert";

function DebriefPanel({ sessionId, onSeek }: { sessionId: string; onSeek: (t: number | null) => void }) {
  const [d, setD] = useState<Debrief | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh = false) => {
    setBusy(true);
    api.debrief(sessionId, refresh).then(setD).finally(() => setBusy(false));
  };
  useEffect(() => load(), [sessionId]);
  if (!d) return <div className="panel muted">{busy ? "Writing the debrief…" : "No debrief."}</div>;
  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Debrief</h2>
        <span
          className={`badge ${d.source === "llm" ? "info" : ""}`}
          title={
            d.source === "llm"
              ? "Written by an LLM from computed facts and validated against them"
              : "Deterministic template from the same facts (no LLM configured, or its output failed validation)"
          }
        >
          {d.source === "llm" ? "AI-written · validated" : "template"}
        </span>
        <button className="sm ghost right" onClick={() => load(true)} disabled={busy}>Regenerate</button>
      </div>
      <p>{d.summary}</p>
      {d.strengths.length > 0 && (
        <>
          <h3>What went well</h3>
          <ul style={{ margin: "0 0 10px", paddingLeft: 18 }}>
            {d.strengths.map((x) => (
              <li key={x} className="small">✓ {x}</li>
            ))}
          </ul>
        </>
      )}
      {d.mistakes.length > 0 && (
        <>
          <h3>What to fix</h3>
          <div className="col" style={{ gap: 8, marginBottom: 10 }}>
            {d.mistakes.map((x, i) => (
              <div key={i} className="card" style={{ padding: "8px 10px" }}>
                <div className="small">
                  {x.track && (
                    <a
                      href="#"
                      className="mono"
                      onClick={(e) => {
                        e.preventDefault();
                        onSeek(x.t);
                      }}
                    >
                      {x.track}
                      {x.t !== null ? ` @ ${clock(x.t)}` : ""}
                    </a>
                  )}{" "}
                  <b>{x.what}</b>
                </div>
                {x.why && <div className="small muted">Why it matters: {x.why}</div>}
                {x.better && <div className="small" style={{ color: "var(--good)" }}>Next time: {x.better}</div>}
              </div>
            ))}
          </div>
        </>
      )}
      {d.pattern && <p className="small"><b>Pattern:</b> {d.pattern}</p>}
      {d.progress && <p className="small"><b>Progress:</b> {d.progress}</p>}
      <p className="small" style={{ marginBottom: 0 }}><b>{d.next_drill}</b></p>
    </div>
  );
}

function SkillPanel({ report, names }: { report: Report; names: Record<string, string> }) {
  const deltas = Object.entries(report.skill_deltas ?? {}).sort((a, b) => a[1] - b[1]);
  return (
    <div className="panel">
      <h2>What the adaptive engine learned</h2>
      {deltas.length ? (
        <table className="data">
          <thead>
            <tr><th>Skill</th><th className="num">Performance</th><th className="num">Rating change</th></tr>
          </thead>
          <tbody>
            {deltas.map(([k, v]) => (
              <tr key={k}>
                <td>{k} · {names[k] ?? k}</td>
                <td className="num">{pct(report.skills[k]?.p)}</td>
                <td className="num" style={{ color: v >= 0 ? "var(--good)" : "var(--alert)" }}>
                  {v >= 0 ? "▲ +" : "▼ "}
                  {v.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty small">No skill evidence in this session (aborted, or nothing to score).</div>
      )}
      <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
        Ratings move by how much better or worse you did than the mission's difficulty predicted. Your next adaptive mission targets the
        weakest one.
      </p>
      {report.ai.suggestions_acted_on > 0 && (
        <div className="card small" style={{ marginTop: 10 }}>
          <b>AI aid use.</b> Agreed with it when it was right: {pct(report.ai.agree_when_right)}. Overrode it when it was wrong:{" "}
          {pct(report.ai.override_when_wrong)}.
        </div>
      )}
    </div>
  );
}

type Filter = "threats" | "problems" | "all";

function DecisionPaths({ report, onSeek }: { report: Report; onSeek: (t: number | null) => void }) {
  const [filter, setFilter] = useState<Filter>("problems");
  const bad = (t: TrackReport) => t.path.some((p) => !p.ok);
  const tracks = report.tracks.filter((t) => (filter === "all" ? true : filter === "threats" ? t.hostile : bad(t)));
  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Decision path per track</h2>
        <span className="small muted">detect → classify → decide/engage → outcome, with the rule behind every point</span>
        <div className="right row" style={{ gap: 4 }}>
          {(["problems", "threats", "all"] as Filter[]).map((f) => (
            <button key={f} className={`sm ${filter === f ? "primary" : ""}`} onClick={() => setFilter(f)}>
              {f === "problems" ? `Problems (${report.tracks.filter(bad).length})` : f === "threats" ? "Threats" : "All tracks"}
            </button>
          ))}
        </div>
      </div>
      <div className="col" style={{ gap: 10 }}>
        {tracks.map((t) => (
          <div key={t.entity} className="card">
            <div className="row" style={{ marginBottom: 6 }}>
              <a
                href="#"
                className="mono"
                style={{ fontWeight: 700 }}
                onClick={(e) => {
                  e.preventDefault();
                  onSeek(t.t0);
                }}
              >
                {t.track ?? "never on the display"}
              </a>
              <span>{CLASS_TEXT[t.true_class]}</span>
              {t.tactic && <span className="faint small">wave {t.wave} · {t.tactic.replace(/_/g, " ")}</span>}
              <span className="right small mono faint">
                D {fmtStage(t.points.detect)} · C {fmtStage(t.points.classify)} · DE {fmtStage(t.points.decide_engage)}
              </span>
            </div>
            <div className="path">
              {t.path.map((p, i) => (
                <div key={i} className={`step ${p.ok ? "ok" : "bad"}`}>
                  <div className="st">
                    {p.stage}
                    {p.t !== null ? ` · ${clock(p.t)}` : ""}
                  </div>
                  <div>{p.text}</div>
                  {(p.hits ?? []).map((h, j) => (
                    <span key={j} className={`hit ${h.severity === "good" ? "good" : ""}`}>
                      {h.severity === "good" ? "✓" : `${h.points > 0 ? "+" : ""}${h.points}`} {h.rule}: {h.msg}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
        {!tracks.length && <div className="empty">{filter === "problems" ? "No problems: every track was handled cleanly." : "No tracks."}</div>}
      </div>
    </div>
  );
}

function RuleHits({ hits }: { hits: Hit[] }) {
  const [open, setOpen] = useState(false);
  const shown = hits.filter((h) => h.severity !== "good");
  return (
    <div className="panel">
      <div className="row">
        <h2 style={{ margin: 0 }}>Scoring detail</h2>
        <span className="small muted">every rule that fired ({shown.length}), from the published rule set</span>
        <button className="sm right" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</button>
      </div>
      {open && (
        <table className="data" style={{ marginTop: 10 }}>
          <thead>
            <tr><th>Time</th><th>Track</th><th>Rule</th><th>Severity</th><th className="num">Points</th><th>Why</th></tr>
          </thead>
          <tbody>
            {shown.map((h, i) => (
              <tr key={i}>
                <td className="mono small">{h.t === null ? "-" : clock(h.t)}</td>
                <td className="mono small">{h.track ?? "-"}</td>
                <td className="mono small">{h.rule}</td>
                <td>
                  <span className={`badge ${h.severity === "critical" ? "alert" : h.severity === "major" ? "warn" : ""}`}>{h.severity}</span>
                </td>
                <td className="num">{h.points}</td>
                <td className="small">{h.msg}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
