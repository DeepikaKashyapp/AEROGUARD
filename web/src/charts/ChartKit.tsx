/**
 * Chart building blocks, following the dataviz method:
 *  - categorical slots in fixed order (validated against this app's dark
 *    surface #111922: blue/orange and blue/red both pass every check),
 *  - one axis per chart (small multiples instead of dual axes),
 *  - 2px lines, >=8px markers with a 2px surface ring, hairline solid grid,
 *  - a hover tooltip on every plot, values first,
 *  - a table view on every chart so no value is chart-only.
 */
import { useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export const VIZ = {
  surface: "#111922",
  grid: "#1f2b36",
  axis: "#33424f",
  muted: "#8b9cab",
  ink: "#d9e3ec",
  series: ["#3987e5", "#d95926"], // slot 1 blue, slot 2 orange (dark steps)
  pos: "#3987e5", // diverging: above baseline
  neg: "#e66767", // diverging: below baseline
  mid: "#383835",
};

export function ChartCard({
  title,
  subtitle,
  legend,
  table,
  children,
  height = 220,
}: {
  title: string;
  subtitle?: string;
  legend?: { label: string; color: string; dashed?: boolean }[];
  table: { columns: string[]; rows: (string | number | null)[][] };
  children: ReactNode;
  height?: number;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="panel chartcard">
      <div className="row" style={{ alignItems: "flex-start", marginBottom: 6 }}>
        <div className="grow">
          <div style={{ fontWeight: 600 }}>{title}</div>
          {subtitle && <div className="small muted">{subtitle}</div>}
        </div>
        <button className="sm ghost" onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>
          {asTable ? "Chart" : "Table"}
        </button>
      </div>
      {legend && legend.length > 1 && !asTable && (
        <div className="row small" style={{ gap: 14, marginBottom: 4 }}>
          {legend.map((l) => (
            <span key={l.label} className="row" style={{ gap: 6 }}>
              <svg width="18" height="8" aria-hidden="true">
                <line x1="1" y1="4" x2="17" y2="4" stroke={l.color} strokeWidth="2" strokeDasharray={l.dashed ? "3 3" : undefined} />
                <circle cx="9" cy="4" r="3" fill={l.color} />
              </svg>
              <span className="muted">{l.label}</span>
            </span>
          ))}
        </div>
      )}
      {asTable ? (
        <div style={{ maxHeight: height, overflow: "auto" }}>
          <table className="data">
            <thead>
              <tr>{table.columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? "num" : ""}>{v ?? "-"}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ height }}>{children}</div>
      )}
    </div>
  );
}

function Tip({ active, payload, label, xLabel, fmt }: {
  active?: boolean;
  payload?: { name: string; value: number | null; color: string; dataKey: string }[];
  label?: string | number;
  xLabel: (x: string | number) => string;
  fmt: (v: number, key: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => p.value !== null && p.value !== undefined);
  if (!rows.length) return null;
  return (
    <div className="viz-tip">
      <div className="faint small">{xLabel(label ?? "")}</div>
      {rows.map((p) => (
        <div key={p.dataKey} className="row" style={{ gap: 8 }}>
          <span className="sw" style={{ background: p.color }} />
          <b className="mono">{fmt(p.value as number, p.dataKey)}</b>
          <span className="muted small">{p.name}</span>
        </div>
      ))}
    </div>
  );
}

const axisProps = {
  stroke: VIZ.axis,
  tick: { fill: VIZ.muted, fontSize: 11 },
  tickLine: false,
};

export interface SeriesSpec {
  key: string;
  name: string;
  color: string;
  connectNulls?: boolean;
  dashed?: boolean;
}

/** Line chart over sessions (x = session number). One y axis, 1-2 series. */
export function SessionLines({
  data,
  series,
  yDomain,
  yFmt = (v) => String(Math.round(v)),
  xLabel = (x) => `Session ${x}`,
  reference,
  onPoint,
}: {
  data: Record<string, number | string | null>[];
  series: SeriesSpec[];
  yDomain?: [number | "auto", number | "auto"];
  yFmt?: (v: number) => string;
  xLabel?: (x: string | number) => string;
  reference?: { y: number; label: string };
  onPoint?: (row: Record<string, number | string | null>) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 18, bottom: 4, left: -8 }}
        onClick={(e: unknown) => {
          const idx = (e as { activeTooltipIndex?: number | string } | null)?.activeTooltipIndex;
          if (onPoint && idx !== undefined && idx !== null) onPoint(data[Number(idx)]);
        }}>
        <CartesianGrid stroke={VIZ.grid} vertical={false} />
        <XAxis dataKey="n" {...axisProps} />
        <YAxis domain={yDomain ?? ["auto", "auto"]} {...axisProps} tickFormatter={yFmt} width={52} />
        {reference && <ReferenceLine y={reference.y} stroke={VIZ.axis} label={{ value: reference.label, fill: VIZ.muted, fontSize: 10, position: "insideTopRight" }} />}
        <Tooltip
          cursor={{ stroke: VIZ.muted, strokeWidth: 1 }}
          content={(p) => <Tip {...(p as unknown as Parameters<typeof Tip>[0])} xLabel={xLabel} fmt={(v) => yFmt(v)} />}
          isAnimationActive={false}
        />
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            strokeDasharray={s.dashed ? "4 4" : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            connectNulls={s.connectNulls}
            dot={{ r: 4, fill: s.color, stroke: VIZ.surface, strokeWidth: 2 }}
            activeDot={{ r: 5, fill: s.color, stroke: VIZ.surface, strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Horizontal bars from a baseline, colored by which side of it they fall (diverging). */
export function DivergingBars({
  rows,
  baseline,
  domain,
  fmt = (v) => String(Math.round(v)),
}: {
  rows: { label: string; value: number; note?: string }[];
  baseline: number;
  domain: [number, number];
  fmt?: (v: number) => string;
}) {
  const data = rows.map((r) => ({ ...r, lo: Math.min(r.value, baseline), hi: Math.max(r.value, baseline), span: [Math.min(r.value, baseline), Math.max(r.value, baseline)] }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 4 }} barCategoryGap={6}>
        <CartesianGrid stroke={VIZ.grid} horizontal={false} />
        <XAxis type="number" domain={domain} {...axisProps} ticks={niceTicks(domain)} />
        <YAxis type="category" dataKey="label" {...axisProps} width={190} tick={{ fill: VIZ.ink, fontSize: 12 }} />
        <ReferenceLine x={baseline} stroke={VIZ.muted} />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
          content={(p) => {
            const row = (p as unknown as { payload?: { payload: (typeof data)[number] }[] }).payload?.[0]?.payload;
            if (!p.active || !row) return null;
            return (
              <div className="viz-tip">
                <b className="mono">{fmt(row.value)}</b> <span className="muted small">{row.label}</span>
                {row.note && <div className="small faint">{row.note}</div>}
              </div>
            );
          }}
          isAnimationActive={false}
        />
        <Bar dataKey="span" maxBarSize={18} isAnimationActive={false} radius={4}>
          {data.map((d) => <Cell key={d.label} fill={d.value >= baseline ? VIZ.pos : VIZ.neg} />)}
          <LabelList dataKey="value" position="right" fill={VIZ.muted} fontSize={11} formatter={(v: unknown) => fmt(Number(v))} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function niceTicks([lo, hi]: [number, number]): number[] {
  const step = hi - lo > 400 ? 100 : 50;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

/** Simple vertical bars, one series (slot 1). */
export function SimpleBars({
  rows,
  yDomain,
  fmt = (v) => String(Math.round(v)),
  xName,
  yName,
}: {
  rows: { label: string; value: number; note?: string }[];
  yDomain?: [number, number];
  fmt?: (v: number) => string;
  xName: string;
  yName: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={rows} margin={{ top: 16, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid stroke={VIZ.grid} vertical={false} />
        <XAxis dataKey="label" {...axisProps} />
        <YAxis domain={yDomain ?? [0, "auto"]} {...axisProps} tickFormatter={fmt} width={44} />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
          content={(p) => {
            const row = (p as unknown as { payload?: { payload: (typeof rows)[number] }[] }).payload?.[0]?.payload;
            if (!p.active || !row) return null;
            return (
              <div className="viz-tip">
                <b className="mono">{fmt(row.value)}</b> <span className="muted small">{yName}</span>
                <div className="small faint">{xName}: {row.label}{row.note ? ` · ${row.note}` : ""}</div>
              </div>
            );
          }}
          isAnimationActive={false}
        />
        <Bar dataKey="value" fill={VIZ.series[0]} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}
          label={{ position: "top", fill: VIZ.muted, fontSize: 11, formatter: (v: number) => fmt(v) } as never} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Stat tile: label, value, optional delta / note. */
export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "good" | "warn" | "alert" }) {
  return (
    <div className="card stat-tile">
      <div className="l">{label}</div>
      <div className={`v ${tone ?? ""}`}>{value}</div>
      {note && <div className="n">{note}</div>}
    </div>
  );
}
