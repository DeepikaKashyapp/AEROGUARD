/**
 * Server-free API for the static preview build (VITE_DEMO=1, scripts/build_preview.sh).
 *
 * The sim and console run for real. What needs the Python server is replaced:
 * recorded responses from the SYNTHETIC demo course (reviews, trends, unit
 * dashboard), pre-generated missions in place of the generator and adaptive
 * engine, and a client-side mission summary in place of rule-tree scoring.
 * Trainees and missions created in the preview live in memory only.
 */
import type { AidModel, Catalogue, Scenario, SessionResult } from "@cuas/sim";
import snapshot from "@preview-snapshot";
import type { Debrief, MissionInfo, Report, SessionBundle, SessionRow, Trainee, Trends, Unit, UnitDashboard } from "../types.ts";

interface Snapshot {
  catalogue: Catalogue;
  aid_model: AidModel;
  skills: Record<string, string>;
  missions: MissionInfo[];
  scenarios: Record<string, Scenario>;
  ladder: { level: number; focus: string[]; scenario: Scenario }[];
  units: Unit[];
  trainees: Trainee[];
  trainee_detail: Record<string, Trainee & { recent: SessionRow[]; skills: Record<string, { rating: number; n: number }> }>;
  trends: Record<string, Trends>;
  dashboards: Record<string, UnitDashboard>;
  reviews: Record<string, SessionBundle>;
  debriefs: Record<string, Debrief>;
  rules: { version: number; yaml: string; author: string; note: string; versions: { version: number; author: string; note: string; created: number }[] };
}

const S = snapshot as unknown as Snapshot;
const now = () => Date.now() / 1000;
const id = (p: string) => `${p}-${Math.random().toString(16).slice(2, 10)}`;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const localUnits: Unit[] = [];
const localTrainees: Trainee[] = [];
const localSessions = new Map<string, { session: SessionRow; scenario: Scenario; result?: SessionResult }>();
let ladderStep = 0;

export const PREVIEW_REVIEW_IDS = Object.keys(S.reviews ?? {});

export function localResult(sid: string): { session: SessionRow; scenario: Scenario; result?: SessionResult } | undefined {
  return localSessions.get(sid);
}

function notInPreview(what: string): never {
  throw new Error(`${what} is not included in this preview. It needs the AEROGUARD server: run ./scripts/start.sh from the repository.`);
}

function sessionRow(trainee_id: string, sc: Scenario, mode: string, mission_id: string | null, plan: SessionRow["plan"], aid_mode: string): SessionRow {
  return {
    id: id("L"),
    trainee_id,
    mode,
    mission_id,
    scenario_id: sc.id,
    scenario_name: sc.name,
    seed: sc.seed,
    level: sc.difficulty.level,
    focus: sc.difficulty.focus,
    tags: sc.tags,
    time_of_day: sc.environment.time_of_day,
    weather: sc.environment.weather,
    aid_mode,
    plan,
    created: now(),
    scored_at: null,
    status: "issued",
    total: null,
    grade: null,
    stages: null,
    metrics: null,
  };
}

export const demoApi = {
  catalogue: async () => S.catalogue,
  aidModel: async () => S.aid_model,
  missions: async () => S.missions,
  skills: async () => S.skills,
  units: async () => [...S.units, ...localUnits],
  createUnit: async (name: string): Promise<Unit> => {
    const u: Unit = { id: id("U"), name, synthetic: 0, created: now(), trainees: 0 };
    localUnits.push(u);
    return u;
  },
  trainees: async (unitId?: string) => [...localTrainees, ...S.trainees].filter((t) => !unitId || t.unit_id === unitId),
  createTrainee: async (name: string, unit_id: string, rank: string): Promise<Trainee> => {
    const unit = localUnits.find((u) => u.id === unit_id) ?? S.units.find((u) => u.id === unit_id);
    const t: Trainee = { id: id("TR"), name, rank, unit_id, unit_name: unit?.name ?? "", synthetic: 0, created: now(), sessions: 0, last_total: null };
    localTrainees.push(t);
    return t;
  },
  trainee: async (tid: string) => {
    if (S.trainee_detail[tid]) return S.trainee_detail[tid];
    const t = localTrainees.find((x) => x.id === tid) ?? notInPreview("This trainee");
    const recent = [...localSessions.values()].filter((x) => x.session.trainee_id === tid).map((x) => x.session).reverse();
    return { ...t, recent, skills: {} };
  },
  trends: async (tid: string): Promise<Trends> => {
    if (S.trends[tid]) return S.trends[tid];
    const t = localTrainees.find((x) => x.id === tid) ?? notInPreview("This trainee");
    return {
      trainee: t,
      sessions: [],
      skills: Object.entries(S.skills).map(([skill, name]) => ({ skill, name, rating: 1000, n: 0 })),
      skill_history: [],
      saturation: [],
      conditions: [],
      tags: {},
      benchmark: { first: null, last: null, n: 0 },
      synthetic: false,
    };
  },
  unitDashboard: async (uid: string): Promise<UnitDashboard> => {
    if (S.dashboards[uid]) return S.dashboards[uid];
    // A unit made in the preview: nothing is scored here, so everyone is at the starting rating.
    const unit = localUnits.find((u) => u.id === uid) ?? notInPreview("This unit's dashboard");
    const skills = Object.fromEntries(Object.keys(S.skills).map((k) => [k, 1000]));
    return {
      unit,
      trainees: localTrainees.filter((t) => t.unit_id === uid).map((t) => ({ id: t.id, name: t.name, rank: t.rank, sessions: 0, last_total: null, recent_mean: null, bench_first: null, bench_last: null, skills })),
      skill_names: S.skills,
      skill_means: skills,
      weakest_skill: null,
      issues: {},
      curve: [],
      synthetic: false,
    };
  },
  issue: async (body: { trainee_id: string; mode: string; mission_id?: string; aid_mode?: string }) => {
    let sc: Scenario;
    let mission_id: string | null = body.mission_id ?? null;
    let plan: SessionRow["plan"] = null;
    if (body.mode === "mission" && body.mission_id) sc = clone(S.scenarios[body.mission_id]);
    else if (body.mode === "benchmark") {
      mission_id = "benchmark_b1";
      sc = clone(S.scenarios.benchmark_b1);
    } else {
      const rung = S.ladder[ladderStep++ % S.ladder.length];
      sc = clone(rung.scenario);
      mission_id = null;
      plan = {
        focus: rung.focus,
        level: rung.level,
        why: `Preview build: a pre-generated mission at difficulty ${Math.round(rung.level * 100)}% focusing on ${rung.focus
          .map((f) => S.skills[f])
          .join(" and ")}. In the full app the adaptive engine builds this from your skill ratings.`,
      };
    }
    const session = sessionRow(body.trainee_id, sc, body.mode === "drill" ? "drill" : body.mode, mission_id, plan, body.aid_mode ?? "off");
    localSessions.set(session.id, { session, scenario: sc });
    return { session, scenario: sc };
  },
  submit: async (sid: string, result: SessionResult) => {
    const s = localSessions.get(sid) ?? notInPreview("This session");
    s.result = result;
    s.session.status = "issued";
    s.session.scored_at = now();
    return { session: s.session, report: null as unknown as Report };
  },
  session: async (sid: string): Promise<SessionBundle> => {
    if (S.reviews[sid]) return S.reviews[sid];
    const s = localSessions.get(sid);
    if (s) return { session: s.session, scenario: s.scenario };
    return notInPreview("This after-action review");
  },
  debrief: async (sid: string) => S.debriefs[sid] ?? notInPreview("This debrief"),
  sessions: async () => [] as SessionRow[],
  rules: async () => S.rules,
  previewRules: async (_yaml: string) => ({
    ok: false,
    error: "Re-scoring runs on the AEROGUARD server. In the preview the rules are read-only.",
    mean_change: 0,
    rows: [] as { session: string; trainee: string; mission: string; old_total: number; old_grade: string; new_total: number; new_grade: string }[],
  }),
  publishRules: async (_yaml: string, _note: string) => notInPreview("Publishing rules"),
  generate: async (_seed: number, level: number, _focus: string[]) => {
    const best = [...S.ladder].sort((a, b) => Math.abs(a.level - level) - Math.abs(b.level - level))[0];
    return clone(best.scenario);
  },
};
