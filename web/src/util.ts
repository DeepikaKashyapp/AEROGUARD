export function inr(x: number | null | undefined): string {
  if (x === null || x === undefined) return "-";
  if (x >= 1e7) return `₹${(x / 1e7).toFixed(2).replace(/\.00$/, "")} Cr`;
  if (x >= 1e5) return `₹${(x / 1e5).toFixed(1).replace(/\.0$/, "")} L`;
  return `₹${Math.round(x).toLocaleString("en-IN")}`;
}

export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const brg = (b: number) => String(Math.round(((b % 360) + 360) % 360)).padStart(3, "0");

export const LABEL_TEXT: Record<string, string> = {
  unknown: "Unknown",
  bird: "Bird",
  friendly: "Friendly UAV",
  civil: "Civil drone",
  recon: "Recon quad",
  fpv: "FPV kamikaze",
  loitering: "Loitering munition",
  decoy: "Decoy",
};

export const CLASS_TEXT: Record<string, string> = {
  bird: "Bird",
  friendly_uav: "Friendly UAV",
  civil_drone: "Civil drone",
  recon_quad: "Recon quad",
  fpv_rf: "FPV (RF)",
  fpv_fiber: "FPV (fiber-optic)",
  loitering_munition: "Loitering munition",
  decoy: "Decoy",
};

export const ROE_TEXT: Record<string, string> = {
  weapons_free: "WEAPONS FREE",
  weapons_tight: "WEAPONS TIGHT",
  weapons_hold: "WEAPONS HOLD",
};

export const KIND_TEXT: Record<string, string> = {
  rf_jam: "RF jam",
  gnss_spoof: "GNSS spoof",
  laser: "Laser",
  rocket: "Rockets",
  missile: "Missile",
  sam: "SAM",
  gun: "Gun",
};

export function when(ts: number | null | undefined): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function pct(x: number | null | undefined): string {
  return x === null || x === undefined ? "-" : `${Math.round(x * 100)}%`;
}

export const STORAGE = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`aeroguard:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(`aeroguard:${key}`);
      else localStorage.setItem(`aeroguard:${key}`, value);
    } catch {
      /* private mode */
    }
  },
};
