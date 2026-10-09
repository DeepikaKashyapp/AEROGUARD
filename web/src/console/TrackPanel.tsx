import type { Label, RoeState, TrackView } from "@cuas/sim";
import { HOSTILITY_COLOR } from "./mapDraw.ts";
import { LABEL_TEXT, brg } from "../util.ts";

export const LABEL_KEYS: [Label, string][] = [
  ["bird", "1"],
  ["friendly", "2"],
  ["civil", "3"],
  ["recon", "4"],
  ["fpv", "5"],
  ["loitering", "6"],
  ["decoy", "7"],
  ["unknown", "0"],
];

interface Props {
  track: TrackView | null;
  roe: RoeState;
  aidOn: boolean;
  onClassify: (label: Label, viaAid?: boolean) => void;
  onDecide: (d: "ignore" | "monitor") => void;
  onAuthority: () => void;
  onCue: () => void;
}

export default function TrackPanel({ track: t, roe, aidOn, onClassify, onDecide, onAuthority, onCue }: Props) {
  if (!t) {
    return (
      <div className="trackpanel">
        <div className="muted small">
          Select a track on the map or in the table (<kbd>N</kbd> jumps to the next new track). Then cue the camera (<kbd>C</kbd>),
          classify (<kbd>1</kbd>–<kbd>7</kbd>) and decide.
        </div>
      </div>
    );
  }
  return (
    <div className="trackpanel">
      <div className="head">
        <span className="tid" style={{ color: HOSTILITY_COLOR[t.hostility] }}>{t.id}</span>
        <span className="muted">{LABEL_TEXT[t.label]}</span>
        {t.down && <span className="badge">SPLASH</span>}
        {!t.displayed && !t.down && <span className="badge warn">LOST</span>}
        <span className="right badge">{t.iff === "friend" ? "IFF: FRIEND" : t.iff === "no_reply" ? "IFF: no reply" : t.iff === "unavailable" ? "IFF: n/a" : "IFF: …"}</span>
      </div>
      <div className="facts">
        <div><span>Bearing</span>{brg(t.bearing)}°</div>
        <div><span>Range</span>{(t.range / 1000).toFixed(2)} km</div>
        <div><span>Altitude</span>{Math.round(t.agl)} m</div>
        <div><span>Speed</span>{t.speed.toFixed(1)} m/s</div>
        <div><span>Time to impact</span>{t.tti === null ? "not closing" : `${t.tti.toFixed(0)} s`}</div>
        <div><span>Climb</span>{t.vz.toFixed(1)} m/s</div>
        <div style={{ gridColumn: "span 2" }}>
          <span>Sensors</span>
          {[t.sources.radar && "radar", t.sources.rf && "RF", t.sources.ac && "acoustic", t.sources.cam && "camera"].filter(Boolean).join(" + ") || "coasting"}
        </div>
        <div style={{ gridColumn: "span 4" }}>
          <span>RF emission</span>
          {t.rfBand ?? <span className="faint">none detected</span>}
        </div>
      </div>
      {aidOn && t.aid && (
        <div className="aid">
          <span>AI aid suggests</span>
          <b>{LABEL_TEXT[t.aid.label]}</b>
          <span className="mono">{Math.round(t.aid.p * 100)}%</span>
          <span className="faint small grow">{t.aid.reasons.join(" · ")}</span>
          <button className="sm" onClick={() => onClassify(t.aid!.label, true)} disabled={t.down}>Accept</button>
        </div>
      )}
      <div className="labels">
        {LABEL_KEYS.map(([l, k]) => (
          <button key={l} className={t.label === l ? "on" : ""} onClick={() => onClassify(l)} disabled={t.down}>
            {LABEL_TEXT[l]} <kbd>{k}</kbd>
          </button>
        ))}
      </div>
      <div className="decide">
        <button onClick={onCue} disabled={t.down}>Cue camera <kbd>C</kbd></button>
        <button onClick={() => onDecide("monitor")} disabled={t.down}>Monitor <kbd>M</kbd></button>
        <button onClick={() => onDecide("ignore")} disabled={t.down}>Ignore <kbd>I</kbd></button>
        {roe === "weapons_hold" && (
          <button onClick={onAuthority} disabled={t.down || t.authority !== "none"}>
            {t.authority === "granted" ? "Authority granted" : t.authority === "requested" ? "Authority requested…" : "Request authority"} <kbd>A</kbd>
          </button>
        )}
      </div>
    </div>
  );
}
