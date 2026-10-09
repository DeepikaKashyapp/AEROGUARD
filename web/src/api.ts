import type { Catalogue, Scenario, SessionResult } from "@cuas/sim";
import type { Debrief, MissionInfo, Report, SessionBundle, SessionRow, Trainee, Trends, Unit, UnitDashboard } from "./types.ts";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {
      /* not json */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

let catalogueCache: Promise<Catalogue> | null = null;

export const api = {
  catalogue: () => (catalogueCache ??= req<Catalogue>("GET", "/api/catalogue")),
  missions: () => req<MissionInfo[]>("GET", "/api/missions"),
  skills: () => req<Record<string, string>>("GET", "/api/skills"),
  units: () => req<Unit[]>("GET", "/api/units"),
  createUnit: (name: string) => req<Unit>("POST", "/api/units", { name }),
  trainees: (unitId?: string) => req<Trainee[]>("GET", `/api/trainees${unitId ? `?unit_id=${unitId}` : ""}`),
  createTrainee: (name: string, unit_id: string, rank: string) => req<Trainee>("POST", "/api/trainees", { name, unit_id, rank }),
  trainee: (id: string) => req<Trainee & { recent: SessionRow[]; skills: Record<string, { rating: number; n: number }> }>("GET", `/api/trainees/${id}`),
  trends: (id: string) => req<Trends>("GET", `/api/trainees/${id}/trends`),
  unitDashboard: (id: string) => req<UnitDashboard>("GET", `/api/units/${id}/dashboard`),
  issue: (body: { trainee_id: string; mode: string; mission_id?: string; seed?: number; level?: number; focus?: string[]; aid_mode?: string }) =>
    req<{ session: SessionRow; scenario: Scenario }>("POST", "/api/sessions", body),
  submit: (sid: string, result: SessionResult) => req<{ session: SessionRow; report: Report }>("POST", `/api/sessions/${sid}/result`, result),
  session: (sid: string) => req<SessionBundle>("GET", `/api/sessions/${sid}`),
  debrief: (sid: string, refresh = false) => req<Debrief>("GET", `/api/sessions/${sid}/debrief${refresh ? "?refresh=true" : ""}`),
  sessions: (q: { trainee_id?: string; unit_id?: string; limit?: number } = {}) =>
    req<SessionRow[]>("GET", `/api/sessions?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  rules: () => req<{ version: number; yaml: string; author: string; note: string; versions: { version: number; author: string; note: string; created: number }[] }>("GET", "/api/rules"),
  previewRules: (yaml: string) =>
    req<{ ok: boolean; error: string | null; mean_change: number; rows: { session: string; trainee: string; mission: string; old_total: number; old_grade: string; new_total: number; new_grade: string }[] }>(
      "POST",
      "/api/rules/preview",
      { yaml },
    ),
  publishRules: (yaml: string, note: string) => req<{ version: number }>("PUT", "/api/rules", { yaml, note, author: "instructor" }),
  generate: (seed: number, level: number, focus: string[]) => req<Scenario>("POST", "/api/scenarios/generate", { seed, level, focus }),
};

/** Hand a scenario from the briefing page to the mission page without re-fetching. */
export const handoff: { scenario: Scenario | null; session: SessionRow | null } = { scenario: null, session: null };
