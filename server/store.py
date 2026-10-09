"""Persistence: SQLite for the index, one folder of JSON per session (PLAN.md 6.14).

data/
  aeroguard.db                 units, trainees, sessions, skill ratings, rule sets
  sessions/<id>/scenario.json  what was issued
  sessions/<id>/result.json    the sim's event log + truth + replay
  sessions/<id>/report.json    the score report
  sessions/<id>/debrief.json   cached debrief
"""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from server.content import ROOT
from server.contracts import Scenario, SessionResult
from server.scoring import RULES_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, synthetic INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS trainees (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, rank TEXT NOT NULL DEFAULT '', unit_id TEXT NOT NULL REFERENCES units(id),
  synthetic INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, trainee_id TEXT NOT NULL REFERENCES trainees(id), mode TEXT NOT NULL,
  mission_id TEXT, scenario_id TEXT NOT NULL, scenario_name TEXT NOT NULL, seed INTEGER NOT NULL,
  level REAL, focus TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]', fingerprint TEXT,
  time_of_day TEXT, weather TEXT, aid_mode TEXT NOT NULL DEFAULT 'off', plan TEXT,
  created REAL NOT NULL, scored_at REAL, status TEXT NOT NULL DEFAULT 'issued',
  rules_version INTEGER, total REAL, grade TEXT, stages TEXT, metrics TEXT, skills TEXT
);
CREATE INDEX IF NOT EXISTS sessions_trainee ON sessions(trainee_id, created);
CREATE TABLE IF NOT EXISTS skill_ratings (
  trainee_id TEXT NOT NULL, skill TEXT NOT NULL, rating REAL NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (trainee_id, skill)
);
CREATE TABLE IF NOT EXISTS skill_history (
  trainee_id TEXT NOT NULL, session_id TEXT NOT NULL, skill TEXT NOT NULL, rating REAL NOT NULL, delta REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS rulesets (
  version INTEGER PRIMARY KEY, yaml TEXT NOT NULL, author TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created REAL NOT NULL
);
"""

JSON_COLS = ("focus", "tags", "stages", "metrics", "skills", "plan")


def _id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


def _row(r: sqlite3.Row | None) -> dict | None:
    if r is None:
        return None
    d = dict(r)
    for k in JSON_COLS:
        if k in d and isinstance(d[k], str):
            d[k] = json.loads(d[k])
    return d


class Store:
    def __init__(self, data_dir: Path | str | None = None):
        self.dir = Path(data_dir or os.environ.get("AEROGUARD_DATA", ROOT / "data"))
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "sessions").mkdir(exist_ok=True)
        self.db_path = self.dir / "aeroguard.db"
        with self.conn() as c:
            c.executescript(SCHEMA)
            if c.execute("SELECT COUNT(*) FROM rulesets").fetchone()[0] == 0:
                c.execute("INSERT INTO rulesets VALUES (1, ?, 'default', 'content/scoring/rules.yaml', ?)", (RULES_PATH.read_text(), time.time()))

    @contextmanager
    def conn(self) -> Iterator[sqlite3.Connection]:
        c = sqlite3.connect(self.db_path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        try:
            yield c
            c.commit()
        finally:
            c.close()

    # -- units & trainees ----------------------------------------------------
    def create_unit(self, name: str, synthetic: bool = False) -> dict:
        uid = _id("U")
        with self.conn() as c:
            c.execute("INSERT INTO units VALUES (?, ?, ?, ?)", (uid, name, int(synthetic), time.time()))
        return self.get_unit(uid)

    def get_unit(self, uid: str) -> dict | None:
        with self.conn() as c:
            return _row(c.execute("SELECT * FROM units WHERE id = ?", (uid,)).fetchone())

    def list_units(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                "SELECT u.*, (SELECT COUNT(*) FROM trainees t WHERE t.unit_id = u.id) AS trainees FROM units u ORDER BY u.synthetic, u.created"
            ).fetchall()
        return [_row(r) for r in rows]

    def create_trainee(self, name: str, unit_id: str, rank: str = "", synthetic: bool = False) -> dict:
        tid = _id("TR")
        with self.conn() as c:
            c.execute("INSERT INTO trainees VALUES (?, ?, ?, ?, ?, ?)", (tid, name, rank, unit_id, int(synthetic), time.time()))
        return self.get_trainee(tid)

    def get_trainee(self, tid: str) -> dict | None:
        with self.conn() as c:
            r = c.execute(
                "SELECT t.*, u.name AS unit_name FROM trainees t JOIN units u ON u.id = t.unit_id WHERE t.id = ?", (tid,)
            ).fetchone()
        return _row(r)

    def list_trainees(self, unit_id: str | None = None) -> list[dict]:
        q = """SELECT t.*, u.name AS unit_name,
                 (SELECT COUNT(*) FROM sessions s WHERE s.trainee_id = t.id AND s.status = 'scored') AS sessions,
                 (SELECT s.total FROM sessions s WHERE s.trainee_id = t.id AND s.status = 'scored' ORDER BY s.scored_at DESC LIMIT 1) AS last_total
               FROM trainees t JOIN units u ON u.id = t.unit_id"""
        args: tuple = ()
        if unit_id:
            q += " WHERE t.unit_id = ?"
            args = (unit_id,)
        with self.conn() as c:
            return [_row(r) for r in c.execute(q + " ORDER BY t.created", args).fetchall()]

    # -- sessions --------------------------------------------------------------
    def _sdir(self, sid: str) -> Path:
        d = self.dir / "sessions" / sid
        d.mkdir(parents=True, exist_ok=True)
        return d

    def create_session(self, trainee_id: str, sc: Scenario, mode: str, mission_id: str | None,
                       aid_mode: str = "off", plan: dict | None = None, created: float | None = None) -> dict:
        sid = _id("S")
        (self._sdir(sid) / "scenario.json").write_text(sc.model_dump_json())
        with self.conn() as c:
            c.execute(
                """INSERT INTO sessions (id, trainee_id, mode, mission_id, scenario_id, scenario_name, seed, level, focus, tags,
                   fingerprint, time_of_day, weather, aid_mode, plan, created)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (sid, trainee_id, mode, mission_id, sc.id, sc.name, sc.seed, sc.difficulty.level,
                 json.dumps([s.value for s in sc.difficulty.focus]), json.dumps(sc.tags), sc.fingerprint,
                 sc.environment.time_of_day.value, sc.environment.weather.value, aid_mode, json.dumps(plan),
                 created or time.time()),
            )
        return self.get_session(sid)

    def get_session(self, sid: str) -> dict | None:
        with self.conn() as c:
            return _row(c.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone())

    def scenario(self, sid: str) -> Scenario:
        return Scenario.model_validate_json((self._sdir(sid) / "scenario.json").read_text())

    def save_result(self, sid: str, result: SessionResult, report: dict, scored_at: float | None = None) -> None:
        d = self._sdir(sid)
        (d / "result.json").write_text(result.model_dump_json())
        (d / "report.json").write_text(json.dumps(report))
        (d / "debrief.json").unlink(missing_ok=True)
        m = report["metrics"]
        summary = {k: m.get(k) for k in (
            "leakers", "damage_total", "fratricides", "roe_violations", "collateral", "wasted_actions", "false_alarms",
            "spent_total", "cost_exchange_ratio", "detect_latency_median", "classification_accuracy", "hostile_total",
            "hostile_neutralised", "recon_completed", "engagements", "mean_time_to_first_action", "night")}
        summary["tags"] = report["tags"]
        summary["ai"] = report.get("ai")
        with self.conn() as c:
            c.execute(
                """UPDATE sessions SET status = 'scored', scored_at = ?, rules_version = ?, total = ?, grade = ?,
                   stages = ?, metrics = ?, skills = ? WHERE id = ?""",
                (scored_at or time.time(), report["rules_version"], report["total"], report["grade"],
                 json.dumps(report["stages"]), json.dumps(summary), json.dumps(report["skills"]), sid),
            )

    def update_report(self, sid: str, report: dict) -> None:
        (self._sdir(sid) / "report.json").write_text(json.dumps(report))

    def result(self, sid: str) -> SessionResult:
        return SessionResult.model_validate_json((self._sdir(sid) / "result.json").read_text())

    def report(self, sid: str) -> dict | None:
        p = self._sdir(sid) / "report.json"
        return json.loads(p.read_text()) if p.exists() else None

    def debrief(self, sid: str) -> dict | None:
        p = self._sdir(sid) / "debrief.json"
        return json.loads(p.read_text()) if p.exists() else None

    def save_debrief(self, sid: str, debrief: dict) -> None:
        (self._sdir(sid) / "debrief.json").write_text(json.dumps(debrief))

    def list_sessions(self, trainee_id: str | None = None, unit_id: str | None = None, scored_only: bool = True,
                      limit: int = 500) -> list[dict]:
        q = "SELECT s.*, t.name AS trainee_name FROM sessions s JOIN trainees t ON t.id = s.trainee_id WHERE 1=1"
        args: list[Any] = []
        if trainee_id:
            q += " AND s.trainee_id = ?"
            args.append(trainee_id)
        if unit_id:
            q += " AND t.unit_id = ?"
            args.append(unit_id)
        if scored_only:
            q += " AND s.status = 'scored'"
        q += " ORDER BY COALESCE(s.scored_at, s.created) LIMIT ?"
        args.append(limit)
        with self.conn() as c:
            return [_row(r) for r in c.execute(q, args).fetchall()]

    def recent_fingerprints(self, trainee_id: str, n: int = 20) -> set[str]:
        with self.conn() as c:
            rows = c.execute("SELECT fingerprint FROM sessions WHERE trainee_id = ? ORDER BY created DESC LIMIT ?", (trainee_id, n)).fetchall()
        return {r[0] for r in rows if r[0]}

    # -- skills ------------------------------------------------------------------
    def skills(self, trainee_id: str) -> dict[str, dict]:
        with self.conn() as c:
            rows = c.execute("SELECT skill, rating, n FROM skill_ratings WHERE trainee_id = ?", (trainee_id,)).fetchall()
        return {r["skill"]: {"rating": r["rating"], "n": r["n"]} for r in rows}

    def set_skills(self, trainee_id: str, session_id: str, ratings: dict[str, dict], deltas: dict[str, float]) -> None:
        with self.conn() as c:
            for skill, v in ratings.items():
                c.execute("INSERT OR REPLACE INTO skill_ratings VALUES (?, ?, ?, ?)", (trainee_id, skill, v["rating"], v["n"]))
            for skill, dv in deltas.items():
                c.execute("INSERT INTO skill_history VALUES (?, ?, ?, ?, ?)", (trainee_id, session_id, skill, ratings[skill]["rating"], dv))

    def skill_history(self, trainee_id: str) -> list[dict]:
        with self.conn() as c:
            rows = c.execute(
                """SELECT h.session_id, h.skill, h.rating, h.delta, s.scored_at FROM skill_history h
                   JOIN sessions s ON s.id = h.session_id WHERE h.trainee_id = ? ORDER BY s.scored_at""", (trainee_id,)
            ).fetchall()
        return [dict(r) for r in rows]

    # -- rules ---------------------------------------------------------------------
    def rules(self) -> dict:
        with self.conn() as c:
            r = c.execute("SELECT * FROM rulesets ORDER BY version DESC LIMIT 1").fetchone()
        return dict(r)

    def rules_versions(self) -> list[dict]:
        with self.conn() as c:
            return [dict(r) for r in c.execute("SELECT version, author, note, created FROM rulesets ORDER BY version DESC").fetchall()]

    def publish_rules(self, text: str, author: str, note: str = "") -> int:
        with self.conn() as c:
            v = c.execute("SELECT COALESCE(MAX(version), 0) + 1 FROM rulesets").fetchone()[0]
            c.execute("INSERT INTO rulesets VALUES (?, ?, ?, ?, ?)", (v, text, author, note, time.time()))
        return v
