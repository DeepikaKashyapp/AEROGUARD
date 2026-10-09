/**
 * Trainee progress (PLAN.md 6.10, 11). The benchmark line is the main
 * evidence of learning: adaptive sessions get harder as the trainee improves,
 * so their raw scores plateau by design.
 */
import { useEffect, useState } from "react";
import { api, handoff } from "../api.ts";
import { go } from "../App.tsx";
import { ChartCard, DivergingBars, SessionLines, SimpleBars, Stat, VIZ } from "../charts/ChartKit.tsx";
import type { Trends } from "../types.ts";
import { pct, when } from "../util.ts";

export const TAG_TEXT: Record<string, string> = {
  leaker: "Strikes got through",
  roe: "ROE violations",
  cost_exchange: "Poor cost-exchange",
  wasted_action: "Wasted jamming / spoofing",
  false_alarm: "Engaged birds",
  fratricide: "Own or civil drones hit",
  collateral: "Fire over no-fire zones",
  recon: "Recon drones finished their orbit",
  hesitation: "Acted too late",
};

export default function TraineePage({ traineeId }: { traineeId: string }) {
  const [t, setT] = useState<Trends | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.trends(traineeId).then(setT).catch((e) => setErr(String(e)));
  }, [traineeId]);
  if (err) return <div className="page"><div className="banner warn">{err}</div></div>;
  if (!t) return <div className="page muted">Loading…</div>;

  const s = t.sessions;
  const last = s[s.length - 1];
  const adaptive = s.filter((x) => x.mode === "adaptive" && x.level !== null);
  const scoreData = s.map((x) => ({ n: x.n, total: x.total, bench: x.benchmark ? x.total : null, id: x.id }));
  const benchDelta = t.benchmark.first !== null && t.benchmark.last !== null && t.benchmark.n > 1 ? t.benchmark.last - t.benchmark.first : null;
  const firstLat = s.find((x) => x.detect_latency !== null)?.detect_latency ?? null;
  const weakest = [...t.skills].sort((a, b) => a.rating - b.rating)[0];

  const start = async () => {
    const r = await api.issue({ trainee_id: traineeId, mode: "adaptive" });
    handoff.scenario = r.scenario;
    handoff.session = r.session;
    go(`briefing/${r.session.id}`);
  };

  return (
    <div className="page">
      {t.synthetic && (
        <div className="banner synthetic" style={{ marginBottom: 12 }}>
          SYNTHETIC trainee: these curves come from a simulated learner flying the real missions, to demo the dashboard. They are not evidence about real people.
        </div>
      )}
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <div>
          <div className="small muted">PROGRESS · {t.trainee.unit_name}</div>
          <h1 style={{ margin: 0 }}>{t.trainee.rank} {t.trainee.name}</h1>
        </div>
        <button className="primary right" onClick={start}>▶ Next adaptive mission</button>
      </div>

      {!s.length ? (
        <div className="empty">No scored sessions yet.</div>
      ) : (
        <>
          <div className="tiles" style={{ marginBottom: 16 }}>
            <Stat label="Sessions" value={s.length} note={`${t.benchmark.n} benchmark`} />
            <Stat label="Latest score" value={last.total.toFixed(0)} note={`grade ${last.grade} · ${last.name}`} />
            <Stat
              label="Benchmark B-1"
              value={t.benchmark.last !== null ? t.benchmark.last.toFixed(0) : "-"}
              note={benchDelta !== null ? `${benchDelta >= 0 ? "▲ +" : "▼ "}${benchDelta.toFixed(0)} since the first benchmark` : "fly it again to measure progress"}
              tone={benchDelta !== null ? (benchDelta >= 0 ? "good" : "alert") : undefined}
            />
            <Stat
              label="Difficulty reached"
              value={adaptive.length ? `${Math.round((adaptive[adaptive.length - 1].level ?? 0) * 100)}%` : "-"}
              note="level of the latest adaptive mission"
            />
            <Stat
              label="Median detection time"
              value={last.detect_latency !== null ? `${last.detect_latency} s` : "-"}
              note={firstLat !== null ? `first session: ${firstLat} s` : undefined}
            />
          </div>

          <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", marginBottom: 16 }}>
            <ChartCard
              title="Score per session"
              subtitle="Benchmark B-1 is the same fixed mission every time: the fair measure of learning. Click a point to open its review."
              legend={[
                { label: "All sessions", color: VIZ.series[0] },
                { label: "Benchmark B-1", color: VIZ.series[1] },
              ]}
              table={{ columns: ["Session", "Mission", "Score", "Benchmark"], rows: s.map((x) => [x.n, x.name, Math.round(x.total), x.benchmark ? "yes" : ""]) }}
              height={250}
            >
              <SessionLines
                data={scoreData}
                series={[
                  { key: "total", name: "All sessions", color: VIZ.series[0] },
                  { key: "bench", name: "Benchmark B-1", color: VIZ.series[1], connectNulls: true },
                ]}
                yDomain={[0, 100]}
                onPoint={(row) => row?.id && go(`aar/${row.id}`)}
              />
            </ChartCard>
            <ChartCard
              title="Difficulty of adaptive missions"
              subtitle="The engine raises the bar as ratings rise: flat scores at rising difficulty are progress."
              table={{ columns: ["Session", "Difficulty", "Focus"], rows: adaptive.map((x) => [x.n, `${Math.round((x.level ?? 0) * 100)}%`, x.focus.join(", ")]) }}
              height={250}
            >
              <SessionLines
                data={s.map((x) => ({ n: x.n, level: x.mode === "adaptive" && x.level !== null ? Math.round(x.level * 100) : null }))}
                series={[{ key: "level", name: "Difficulty", color: VIZ.series[0], connectNulls: true }]}
                yDomain={[0, 100]}
                yFmt={(v) => `${Math.round(v)}%`}
              />
            </ChartCard>
          </div>

          <div className="grid three" style={{ marginBottom: 16 }}>
            <ChartCard title="Median detection time" subtitle="seconds from a track appearing to hooking it (target < 4 s)"
              table={{ columns: ["Session", "Seconds"], rows: s.map((x) => [x.n, x.detect_latency]) }} height={170}>
              <SessionLines data={s.map((x) => ({ n: x.n, v: x.detect_latency }))} series={[{ key: "v", name: "seconds", color: VIZ.series[0], connectNulls: true }]}
                yDomain={[0, "auto"]} yFmt={(v) => `${v.toFixed(0)}s`} reference={{ y: 4, label: "4 s" }} />
            </ChartCard>
            <ChartCard title="Classification accuracy" subtitle="tracks called correctly"
              table={{ columns: ["Session", "Accuracy"], rows: s.map((x) => [x.n, pct(x.classification_accuracy)]) }} height={170}>
              <SessionLines data={s.map((x) => ({ n: x.n, v: x.classification_accuracy === null ? null : Math.round(x.classification_accuracy * 100) }))}
                series={[{ key: "v", name: "accuracy", color: VIZ.series[0], connectNulls: true }]} yDomain={[0, 100]} yFmt={(v) => `${Math.round(v)}%`} />
            </ChartCard>
            <ChartCard title="Cost-exchange" subtitle="₹ spent per ₹ of drones stopped (lower is better)"
              table={{ columns: ["Session", "Ratio"], rows: s.map((x) => [x.n, x.cost_exchange_ratio]) }} height={170}>
              <SessionLines data={s.map((x) => ({ n: x.n, v: x.cost_exchange_ratio }))} series={[{ key: "v", name: "ratio", color: VIZ.series[0], connectNulls: true }]}
                yDomain={[0, "auto"]} yFmt={(v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}×`} reference={{ y: 1, label: "break-even" }} />
            </ChartCard>
          </div>

          <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)", marginBottom: 16 }}>
            <ChartCard
              title="Skill ratings"
              subtitle={`Every trainee starts at 1000. Weakest now: ${weakest.name} (${weakest.rating}). The next adaptive mission will most likely target it.`}
              table={{ columns: ["Skill", "Rating", "Missions"], rows: t.skills.map((k) => [`${k.skill} · ${k.name}`, k.rating, k.n]) }}
              height={290}
            >
              <DivergingBars
                rows={t.skills.map((k) => ({ label: `${k.skill} ${k.name}`, value: k.rating, note: `${k.n} missions of evidence` }))}
                baseline={1000}
                domain={[Math.floor(Math.min(850, ...t.skills.map((k) => k.rating - 20)) / 50) * 50, Math.ceil(Math.max(1150, ...t.skills.map((k) => k.rating + 40)) / 50) * 50]}
              />
            </ChartCard>
            <div className="col" style={{ gap: 16 }}>
              <ChartCard
                title="Decisions under saturation"
                subtitle="share of engagements with no rule broken, by how many tracks were on the display"
                table={{ columns: ["Tracks on display", "Good decisions", "Decisions"], rows: t.saturation.map((b) => [b.bucket, `${b.good_pct}%`, b.decisions]) }}
                height={170}
              >
                <SimpleBars rows={t.saturation.map((b) => ({ label: b.bucket, value: b.good_pct, note: `${b.decisions} decisions` }))} yDomain={[0, 100]} fmt={(v) => `${Math.round(v)}%`} xName="tracks on display" yName="good decisions" />
              </ChartCard>
              <div className="panel">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Recurring issues</div>
                <table className="data">
                  <tbody>
                    {Object.entries(t.tags).slice(0, 6).map(([k, v]) => (
                      <tr key={k}><td>{TAG_TEXT[k] ?? k}</td><td className="num">{v}</td></tr>
                    ))}
                    {!Object.keys(t.tags).length && <tr><td className="faint">None yet.</td></tr>}
                  </tbody>
                </table>
                {t.conditions.length > 1 && (
                  <div className="small muted" style={{ marginTop: 8 }}>
                    {t.conditions.map((c) => `${c.condition}: mean ${c.mean_total} over ${c.sessions} sessions`).join(" · ")}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>Sessions</h2>
            <table className="data">
              <thead><tr><th>#</th><th>When</th><th>Mission</th><th>Mode</th><th className="num">Difficulty</th><th className="num">Score</th><th>Grade</th></tr></thead>
              <tbody>
                {[...s].reverse().map((x) => (
                  <tr key={x.id} className="click" onClick={() => go(`aar/${x.id}`)}>
                    <td className="mono">{x.n}</td>
                    <td className="small">{when(x.scored_at)}</td>
                    <td>{x.name}</td>
                    <td className="small muted">{x.mode}{x.focus.length ? ` · ${x.focus.join(",")}` : ""}</td>
                    <td className="num">{x.level !== null ? `${Math.round(x.level * 100)}%` : "-"}</td>
                    <td className="num">{x.total.toFixed(1)}</td>
                    <td><span className={`grade ${x.grade}`}>{x.grade}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
