import type { TrackView } from "@cuas/sim";
import { HOSTILITY_COLOR } from "./mapDraw.ts";
import { brg } from "../util.ts";

interface Props {
  tracks: TrackView[];
  selected: string | null;
  onSelect: (id: string) => void;
}

/** Sorted by time-to-impact: the operator works the most urgent track first. */
export function sortTracks(tracks: TrackView[]): TrackView[] {
  const rank = (t: TrackView) => (t.down ? 3 : !t.displayed ? 2 : 0);
  return [...tracks].sort((a, b) => rank(a) - rank(b) || (a.tti ?? 1e9) - (b.tti ?? 1e9) || a.range - b.range);
}

export default function TrackTable({ tracks, selected, onSelect }: Props) {
  const rows = sortTracks(tracks);
  return (
    <div className="tracktable">
      <table>
        <thead>
          <tr>
            <th>TRK</th>
            <th>CLASS</th>
            <th>BRG</th>
            <th>RNG km</th>
            <th>ALT m</th>
            <th>SPD m/s</th>
            <th>TTI s</th>
            <th>SRC</th>
            <th>IFF</th>
            <th>STATUS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const cls = [t.id === selected ? "sel" : "", !t.hooked && t.displayed ? "new" : "", t.down ? "down" : "", !t.displayed && !t.down ? "lost" : ""].join(" ");
            const tti = t.tti;
            return (
              <tr key={t.id} className={cls} onClick={() => onSelect(t.id)}>
                <td style={{ color: HOSTILITY_COLOR[t.hostility], fontWeight: 700 }}>{t.id}</td>
                <td>{t.label === "unknown" ? <span className="faint">unknown</span> : t.label}</td>
                <td>{brg(t.bearing)}</td>
                <td>{(t.range / 1000).toFixed(1)}</td>
                <td>{Math.round(t.agl)}</td>
                <td>{t.speed.toFixed(0)}</td>
                <td className={tti !== null && tti < 30 ? "tti-hot" : tti !== null && tti < 60 ? "tti-warm" : ""}>{tti === null ? "-" : tti.toFixed(0)}</td>
                <td>
                  <span className="src">
                    <span className={t.sources.radar ? "on r" : ""}>R</span>
                    <span className={t.sources.rf ? "on f" : ""}>F</span>
                    <span className={t.sources.ac ? "on a" : ""}>A</span>
                    <span className={t.sources.cam ? "on c" : ""}>C</span>
                  </span>
                </td>
                <td>{t.iff === "friend" ? <span style={{ color: "var(--friend)" }}>FRIEND</span> : t.iff === "no_reply" ? "none" : t.iff === "unavailable" ? "n/a" : "…"}</td>
                <td>
                  {t.down ? "SPLASH" : !t.displayed ? "LOST" : t.engagedBy.length ? <span style={{ color: "var(--warn)" }}>ENGAGED {t.engagedBy.join(",")}</span> : t.decision !== "none" ? t.decision.toUpperCase() : !t.hooked ? <span style={{ color: "var(--unknown)" }}>NEW</span> : ""}
                </td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr>
              <td colSpan={10} className="faint" style={{ padding: 14 }}>
                No tracks. Sensors are searching…
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
