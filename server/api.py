"""AEROGUARD HTTP API (PLAN.md 6.14). Serves the built web app too.

    uvicorn server.api:app --port 8000
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from server import service
from server.content import ROOT, catalogue_json
from server.contracts import SessionResult
from server.generator import SKILL_NAMES, list_missions, procedural
from server.store import Store

app = FastAPI(title="AEROGUARD", version="0.1.0")
app.add_middleware(GZipMiddleware, minimum_size=2048)
store = Store()


def _wrap(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except service.NotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except service.BadRequest as exc:
        raise HTTPException(400, str(exc)) from exc


class UnitIn(BaseModel):
    name: str


class TraineeIn(BaseModel):
    name: str
    unit_id: str
    rank: str = ""


class SessionIn(BaseModel):
    trainee_id: str
    mode: Literal["adaptive", "mission", "benchmark", "drill"] = "adaptive"
    mission_id: Optional[str] = None
    seed: Optional[int] = None
    level: Optional[float] = None
    focus: Optional[list[str]] = None
    aid_mode: Literal["off", "honest", "unreliable"] = "off"


class RulesIn(BaseModel):
    yaml: str
    author: str = "instructor"
    note: str = ""


class GenerateIn(BaseModel):
    seed: int
    level: float = 0.4
    focus: list[str] = []


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/catalogue")
def catalogue():
    return catalogue_json()


@app.get("/api/missions")
def missions():
    return list_missions()


@app.get("/api/skills")
def skills():
    return {k.value: v for k, v in SKILL_NAMES.items()}


@app.get("/api/units")
def units():
    return store.list_units()


@app.post("/api/units")
def create_unit(body: UnitIn):
    return store.create_unit(body.name)


@app.get("/api/units/{unit_id}/dashboard")
def unit_dashboard(unit_id: str):
    return _wrap(service.unit_dashboard, store, unit_id)


@app.get("/api/trainees")
def trainees(unit_id: Optional[str] = None):
    return store.list_trainees(unit_id)


@app.post("/api/trainees")
def create_trainee(body: TraineeIn):
    if not store.get_unit(body.unit_id):
        raise HTTPException(404, "no such unit")
    return store.create_trainee(body.name, body.unit_id, body.rank)


@app.get("/api/trainees/{trainee_id}")
def trainee(trainee_id: str):
    t = store.get_trainee(trainee_id)
    if not t:
        raise HTTPException(404, "no such trainee")
    return {**t, "skills": store.skills(trainee_id), "recent": store.list_sessions(trainee_id)[-8:][::-1]}


@app.get("/api/trainees/{trainee_id}/trends")
def trends(trainee_id: str):
    return _wrap(service.trends, store, trainee_id)


@app.post("/api/sessions")
def create_session(body: SessionIn):
    sess, sc = _wrap(service.issue_session, store, body.trainee_id, body.mode, body.mission_id, body.seed,
                     body.level, body.focus, body.aid_mode)
    return {"session": sess, "scenario": sc.model_dump(mode="json")}


@app.post("/api/sessions/{session_id}/result")
def submit(session_id: str, result: SessionResult):
    report = _wrap(service.submit_result, store, session_id, result)
    return {"session": store.get_session(session_id), "report": report}


@app.get("/api/sessions/{session_id}")
def session(session_id: str):
    return _wrap(service.session_bundle, store, session_id)


@app.get("/api/sessions/{session_id}/debrief")
def debrief(session_id: str, refresh: bool = False):
    return _wrap(service.get_debrief, store, session_id, refresh)


@app.get("/api/sessions")
def sessions(trainee_id: Optional[str] = None, unit_id: Optional[str] = None, limit: int = 50):
    return store.list_sessions(trainee_id, unit_id, limit=limit)[-limit:][::-1]


@app.get("/api/rules")
def rules():
    return {**store.rules(), "versions": store.rules_versions()}


@app.post("/api/rules/preview")
def rules_preview(body: RulesIn):
    return service.rules_preview(store, body.yaml)


@app.put("/api/rules")
def publish_rules(body: RulesIn):
    check = service.rules_preview(store, body.yaml, limit=0)
    if not check["ok"]:
        raise HTTPException(400, check["error"])
    return {"version": store.publish_rules(body.yaml, body.author, body.note)}


@app.post("/api/scenarios/generate")
def generate(body: GenerateIn):
    return procedural(body.seed, body.level, body.focus, mode="drill").model_dump(mode="json")


# ---------------------------------------------------------------------------
# the built web app (npm run build:web)
# ---------------------------------------------------------------------------

DIST = ROOT / "web" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        if path and f.is_file() and Path(f).resolve().is_relative_to(DIST.resolve()):
            return FileResponse(f)
        return FileResponse(DIST / "index.html")
