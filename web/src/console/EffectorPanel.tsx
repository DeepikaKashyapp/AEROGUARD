import type { EffectorView, Sim, TrackView } from "@cuas/sim";
import { KIND_TEXT, inr } from "../util.ts";

const KIND_KEYS: Record<string, string[]> = {
  rf_jam: ["J"],
  gnss_spoof: ["G"],
  laser: ["L"],
  rocket: ["K"],
  missile: ["X"],
  sam: ["S"],
  gun: ["U", "Y"],
};

/** Hotkey per effector, by kind (second gun gets Y). */
export function effectorKeys(effectors: EffectorView[]): Map<string, string> {
  const used: Record<string, number> = {};
  const out = new Map<string, string>();
  for (const f of effectors) {
    const keys = KIND_KEYS[f.kind] ?? [];
    const i = used[f.kind] ?? 0;
    used[f.kind] = i + 1;
    if (keys[i]) out.set(f.id, keys[i]);
  }
  return out;
}

/** Can this effector reach the selected track right now (range + line of sight)? */
export function reach(sim: Sim, effId: string, track: TrackView | null): boolean {
  if (!track || track.down || !track.displayed) return false;
  const f = sim.effectors.find((x) => x.id === effId);
  if (!f) return false;
  const p = { x: track.x, y: track.y, z: track.z };
  if (Math.hypot(f.pos.x - p.x, f.pos.y - p.y, f.pos.z - p.z) > f.spec.range_m) return false;
  return !f.spec.needs_los || sim.terrain.los(f.pos, p);
}

interface Props {
  sim: Sim;
  effectors: EffectorView[];
  track: TrackView | null;
  onEngage: (id: string) => void;
  onCease: (id: string) => void;
  onHover: (id: string | null) => void;
}

const ICON: Record<string, string> = { rf_jam: "📡", gnss_spoof: "🛰", laser: "✴", rocket: "➶", missile: "⇡", sam: "⇈", gun: "⁂" };

export default function EffectorPanel({ sim, effectors, track, onEngage, onCease, onHover }: Props) {
  const keys = effectorKeys(effectors);
  return (
    <div className="effectors">
      <h3 style={{ margin: "2px 0 8px" }}>Effectors {track ? <span className="faint">· target {track.id}</span> : <span className="faint">· select a track</span>}</h3>
      {effectors.map((f) => {
        const active = f.status === "active" || f.status === "slewing";
        const inRange = reach(sim, f.id, track);
        const ready = f.status === "ready";
        return (
          <button
            key={f.id}
            className={`eff ${inRange && ready ? "inrange" : ""} ${active ? "busy" : ""}`}
            onClick={() => (active ? onCease(f.id) : onEngage(f.id))}
            onMouseEnter={() => onHover(f.id)}
            onMouseLeave={() => onHover(null)}
            disabled={!active && (!track || f.status === "empty")}
            title={active ? "Click to cease" : `${f.name}: ${KIND_TEXT[f.kind]}, range ${(f.range / 1000).toFixed(2)} km`}
          >
            <span className="k" aria-hidden="true">{ICON[f.kind]}</span>
            <span className="n">
              {f.name} {keys.get(f.id) && <kbd>{keys.get(f.id)}</kbd>}
            </span>
            <span className="s">
              {active ? (
                <span style={{ color: "var(--warn)" }}>{f.status === "slewing" ? "SLEW" : "ACTIVE"} → {f.targetTrack}</span>
              ) : f.status === "reloading" ? (
                <span className="faint">reloading</span>
              ) : f.status === "empty" ? (
                <span style={{ color: "var(--alert)" }}>EMPTY</span>
              ) : (
                <span style={{ color: "var(--good)" }}>READY</span>
              )}
              <br />
              <span className="faint">{f.ammo === null ? "∞" : `${f.ammo} rds`}</span>
            </span>
            <span className="m">
              {KIND_TEXT[f.kind]} · {(f.range / 1000).toFixed(2)} km · {inr(f.costPerUse)}/{f.kill === "soft" ? "use" : f.kind === "gun" ? "burst" : "shot"}
            </span>
            {active && f.progress !== null && (
              <span className="bar">
                <i style={{ width: `${Math.round(f.progress * 100)}%` }} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
