/** Shapes of the server's JSON (server/service.py, server/scoring.py). */
import type { Replay, Scenario, SimEvent, TruthEntity } from "@cuas/sim";

export interface Unit {
  id: string;
  name: string;
  synthetic: number;
  created: number;
  trainees?: number;
}

export interface Trainee {
  id: string;
  name: string;
  rank: string;
  unit_id: string;
  unit_name: string;
  synthetic: number;
  created: number;
  sessions?: number;
  last_total?: number | null;
}

export interface Plan {
  why: string;
  focus: string[];
  level: number;
}

export interface SessionRow {
  id: string;
  trainee_id: string;
  trainee_name?: string;
  mode: string;
  mission_id: string | null;
  scenario_id: string;
  scenario_name: string;
  seed: number;
  level: number | null;
  focus: string[];
  tags: string[];
  time_of_day: string;
  weather: string;
  aid_mode: string;
  plan: Plan | null;
  created: number;
  scored_at: number | null;
  status: "issued" | "scored";
  total: number | null;
  grade: string | null;
  stages: Record<string, number | null> | null;
  metrics: Record<string, unknown> | null;
}

export interface Hit {
  rule: string;
  entity: string | null;
  track: string | null;
  t: number | null;
  points: number;
  severity: "minor" | "major" | "critical" | "good";
  tag: string;
  cap_grade: string | null;
  msg: string;
}

export interface PathStep {
  stage: "detect" | "classify" | "engage" | "decide" | "outcome";
  t: number | null;
  ok: boolean;
  points: number | null;
  text: string;
  hits?: Hit[];
}

export interface TrackReport {
  entity: string;
  track: string | null;
  true_class: string;
  true_label: string;
  hostile: boolean;
  link: string;
  outcome: string;
  t0: number | null;
  wave: string | null;
  tactic: string | null;
  points: Record<string, number | null>;
  path: PathStep[];
}

export interface Report {
  rules_version: number;
  total: number;
  grade: string;
  capped_by: string[];
  stages: Record<string, number | null>;
  metrics: Record<string, any>;
  tracks: TrackReport[];
  hits: Hit[];
  mission_hits: Hit[];
  tags: Record<string, number>;
  hesitation: { track: string | null; from: number; to: number; acted: boolean }[];
  saturation: { n_active: number; ok: boolean }[];
  skills: Record<string, { p: number; w: number }>;
  skill_deltas?: Record<string, number>;
  ai: { suggestions_acted_on: number; agree_when_right: number | null; override_when_wrong: number | null };
}

export interface SessionBundle {
  session: SessionRow;
  scenario: Scenario;
  report?: Report;
  replay?: Replay | null;
  truth?: TruthEntity[];
  events?: SimEvent[];
  trainee?: Trainee;
}

export interface Debrief {
  source: "llm" | "template";
  summary: string;
  strengths: string[];
  mistakes: { track: string | null; t: number | null; what: string; why: string; better: string }[];
  pattern: string | null;
  progress?: string | null;
  next_drill: string;
  llm_problems?: string[];
}

export interface MissionInfo {
  id: string;
  name: string;
  mode: string;
  tags: string[];
  briefing: string;
  time_of_day: string;
  weather: string;
  roe: string;
  fixed_seed: number | null;
}

export interface Trends {
  trainee: Trainee;
  sessions: {
    n: number;
    id: string;
    scored_at: number;
    mode: string;
    mission_id: string | null;
    name: string;
    total: number;
    grade: string;
    stages: Record<string, number | null>;
    level: number | null;
    focus: string[];
    benchmark: boolean;
    night: boolean | null;
    leakers: number | null;
    detect_latency: number | null;
    classification_accuracy: number | null;
    cost_exchange_ratio: number | null;
    spent: number | null;
    time_to_first_action: number | null;
  }[];
  skills: { skill: string; name: string; rating: number; n: number }[];
  skill_history: { session_id: string; skill: string; rating: number; delta: number; scored_at: number }[];
  saturation: { bucket: string; decisions: number; good_pct: number }[];
  conditions: { condition: string; sessions: number; mean_total: number }[];
  tags: Record<string, number>;
  benchmark: { first: number | null; last: number | null; n: number };
  synthetic: boolean;
}

export interface UnitDashboard {
  unit: Unit;
  trainees: {
    id: string;
    name: string;
    rank: string;
    sessions: number;
    last_total: number | null;
    recent_mean: number | null;
    bench_first: number | null;
    bench_last: number | null;
    skills: Record<string, number>;
  }[];
  skill_names: Record<string, string>;
  skill_means: Record<string, number>;
  weakest_skill: string | null;
  issues: Record<string, number>;
  curve: { n: number; mean_total: number; trainees: number }[];
  synthetic: boolean;
}
