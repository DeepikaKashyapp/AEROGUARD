/**
 * Preview-build mission summary. The full app scores a mission on the server
 * (rule tree, debrief, adaptive update); the static preview cannot, so it
 * shows plain facts computed from the event log, plus the replay.
 */
import type { Catalogue, SessionResult } from "@cuas/sim";
import { useEffect, useState } from "react";
import Replay from "../aar/Replay.tsx";
import { api, handoff } from "../api.ts";
import { go } from "../App.tsx";
import { Stat } from "../charts/ChartKit.tsx";
import { PREVIEW_REVIEW_IDS, localResult } from "../demo/demoApi.ts";
import type { Report, SessionBundle } from "../types.ts";
import { CLASS_TEXT, LABEL_TEXT, inr, pct } from "../util.ts";

export default function SummaryPage({ sessionId }: { sessionId: string }) {
  const [cat, setCat] = useState<Catalogue | null>(null);
  useEffect(() => {
    api.catalogue().then(setCat);
  }, []);
  const local = localResult(sessionId);
  if (!local?.result) return <div className="page"><div className="empty">This mission summary is no longer in memory (the preview keeps played missions only until the page reloads).</div></div>;
  if (!cat) return <div className="page muted">Loading…</div>;
  const r = local.result;
  const s = summarise(r, cat);
  const bundle: SessionBundle = { session: local.session, scenario: local.scenario, replay: r.replay, events: r.events.filter((e) => e.type !== "camera") };
  const pseudoReport = { tracks: s.rows.map((x) => ({ track: x.track, true_class: x.cls })), hesitation: s.hesitation } as unknown as Report;

  const again = async () => {
    const res = await api.issue({ trainee_id: local.session.trainee_id, mode: local.session.mode === "adaptive" ? "adaptive" : local.session.mode === "benchmark" ? "benchmark" : "mission", mission_id: local.session.mission_id ?? undefined, aid_mode: local.session.aid_mode });
    handoff.scenario = res.scenario;
    handoff.session = res.session;
    go(`briefing/${res.session.id}`);
  };

  return (
    <div className="page col" style={{ gap: 16 }}>
      <div className="row wrap" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="small muted">MISSION SUMMARY · PREVIEW BUILD</div>
          <h1 style={{ margin: 0 }}>{local.scenario.name}</h1>
          <div className="muted small">{r.ended_reason.replace("_", " ")} after {Math.round(r.duration_s)} s</div>
        </div>
        <div className="right row wrap">
          <button className="primary" onClick={again}>Fly again →</button>
          <a className="btn" href="#/">Trainees</a>
        </div>
      </div>
      <div className="banner" style={{ background: "#0f2230", border: "1px solid #1d4a66" }}>
        These are the raw facts of your mission. In the full app the server also scores every decision with the rule tree (stage scores, grade,
        the rule behind every point), writes a debrief and updates your skill ratings.{" "}
        {PREVIEW_REVIEW_IDS[0] && <>See one: <a href={`#/aar/${PREVIEW_REVIEW_IDS[0]}`}>a recorded full after-action review</a>.</>}
      </div>
      <div className="tiles">
        <Stat label="Threats stopped" value={`${s.stopped} / ${s.hostile}`} note={`${s.leakers} got through`} tone={s.leakers ? "alert" : "good"} />
        <Stat label="Assets" value={`${Math.round(s.minHealth)}%`} note="health of the worst-hit asset" tone={s.minHealth >= 99 ? "good" : s.minHealth > 40 ? "warn" : "alert"} />
        <Stat label="Spent" value={inr(s.spent)} note={s.cx !== null ? `${s.cx.toFixed(2)}× the value of drones stopped` : "nothing stopped"} />
        <Stat label="Median detection time" value={s.medianDetect === null ? "-" : `${s.medianDetect.toFixed(1)} s`} note="target: under 4 s" />
        <Stat label="Classification accuracy" value={pct(s.accuracy)} />
        <Stat label="Own drones hit · wasted jams · costly shots" value={`${s.fratricide} · ${s.wastedJams} · ${s.costly}`} tone={s.fratricide ? "alert" : s.wastedJams || s.costly ? "warn" : undefined} />
      </div>
      <div className="panel" style={{ overflowX: "auto" }}>
        <h2>Every threat and what you did</h2>
        <table className="data">
          <thead><tr><th>Track</th><th>What it was</th><th>You called it</th><th>Actions</th><th>Outcome</th></tr></thead>
          <tbody>
            {s.rows.map((x) => (
              <tr key={x.entity}>
                <td className="mono">{x.track ?? <span className="faint">never seen</span>}</td>
                <td>{CLASS_TEXT[x.cls]}</td>
                <td style={{ color: x.label === "unknown" ? "var(--faint)" : x.correct ? "var(--good)" : "var(--alert)" }}>{LABEL_TEXT[x.label]}</td>
                <td className="small">{x.actions.join(" · ") || <span className="faint">none</span>}</td>
                <td style={{ color: x.good ? "var(--good)" : x.outcome === "leaked" ? "var(--alert)" : undefined }}>{x.outcome.replace("_", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.replay && <Replay bundle={bundle} catalogue={cat} report={pseudoReport} />}
    </div>
  );
}

function summarise(r: SessionResult, cat: Catalogue) {
  const ev = r.events;
  const byOrder = new Map(ev.filter((e) => e.type === "engage_result").map((e) => [e.data.order, e]));
  const truth = new Map(r.truth.map((t) => [t.id, t]));
  const hostile = r.truth.filter((t) => t.hostile);
  const stopped = hostile.filter((t) => ["neutralised", "link_lost", "diverted"].includes(t.outcome));
  const spent = ev.filter((e) => e.type === "engage_result").reduce((a, e) => a + Number(e.data.spent ?? 0), 0);
  const value = stopped.reduce((a, t) => a + t.cost_inr, 0);
  const lat = ev.filter((e) => e.type === "hook" && e.entity && truth.get(e.entity)?.hostile).map((e) => Number(e.data.latency)).sort((a, b) => a - b);
  const lastLabel = new Map<string, string>();
  for (const e of ev) if (e.type === "classify" && e.entity) lastLabel.set(e.entity, String(e.data.label));
  const judged = r.truth.filter((t) => t.track && (t.hostile || t.cls === "friendly_uav" || t.cls === "civil_drone"));
  const orders = ev.filter((e) => e.type === "engage_order");
  const wastedJams = orders.filter((e) => e.data.kind === "rf_jam" && e.entity && truth.get(e.entity)?.hostile && truth.get(e.entity)?.link !== "rf").length;
  const costly = orders.filter((e) => {
    const t = e.entity ? truth.get(e.entity) : undefined;
    const spentOn = Number(byOrder.get(e.data.order)?.data.spent ?? e.data.est_cost ?? 0);
    return t?.hostile && t.cost_inr > 0 && spentOn / t.cost_inr > 15;
  }).length;
  const fratricide = ev.filter((e) => e.type === "neutralised" && (e.data.friendly || e.data.civil)).length + ev.filter((e) => e.type === "friendly_affected").length;
  const hesitation = hostile
    .filter((t) => t.t_first_displayed !== null && t.track)
    .map((t) => {
      const first = ev.find((e) => e.entity === t.id && (e.type === "engage_order" || e.type === "decision"));
      const end = first ? first.t : (t.outcome_t ?? r.duration_s);
      return end - (t.t_first_displayed ?? 0) > 15 ? { track: t.track, from: (t.t_first_displayed ?? 0) + 15, to: end, acted: !!first } : null;
    })
    .filter(Boolean);
  const rows = [...hostile, ...r.truth.filter((t) => !t.hostile && t.cls !== "bird" && t.track)]
    .sort((a, b) => (a.t_first_displayed ?? 1e9) - (b.t_first_displayed ?? 1e9))
    .map((t) => {
      const label = lastLabel.get(t.id) ?? "unknown";
      return {
        entity: t.id,
        track: t.track,
        cls: t.cls,
        label,
        correct: label === t.label,
        actions: orders
          .filter((e) => e.entity === t.id)
          .map((e) => `${cat.effectors[String(e.data.type)]?.name ?? e.data.effector} → ${String(byOrder.get(e.data.order)?.data.result ?? "?").replace("_", " ")}`),
        outcome: t.outcome,
        good: t.hostile ? ["neutralised", "link_lost", "diverted", "expended"].includes(t.outcome) : t.outcome !== "neutralised",
      };
    });
  return {
    hostile: hostile.length,
    stopped: stopped.length,
    leakers: hostile.filter((t) => t.outcome === "leaked").length,
    minHealth: Math.min(...Object.values(r.assets_health)),
    spent,
    cx: value ? spent / value : null,
    medianDetect: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    accuracy: judged.length ? judged.filter((t) => lastLabel.get(t.id) === t.label).length / judged.length : null,
    wastedJams,
    costly,
    fratricide,
    hesitation,
    rows,
  };
}
