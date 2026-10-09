"""End-to-end through the HTTP API: issue -> play (a bot) -> submit -> score -> AAR -> trends."""
import importlib
import json
import subprocess

import pytest
from fastapi.testclient import TestClient

from conftest import ROOT


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AEROGUARD_DATA", str(tmp_path / "data"))
    import server.api
    importlib.reload(server.api)
    return TestClient(server.api.app)


def play(scenario: dict, tmp_path, bot="oracle", skill=None) -> dict:
    sp = tmp_path / "sc.json"
    sp.write_text(json.dumps(scenario))
    out = tmp_path / "res.json"
    cmd = ["node", "bots/src/cli.ts", "--bot", bot, "--scenario", str(sp), "--out", str(out)]
    if skill is not None:
        cmd += ["--skill", str(skill)]
    subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True)
    return json.loads(out.read_text())


def test_full_loop(client, tmp_path):
    unit = client.post("/api/units", json={"name": "Course 81"}).json()
    tr = client.post("/api/trainees", json={"name": "Maj A. Rao", "unit_id": unit["id"], "rank": "Maj"}).json()

    # first adaptive session is the familiarisation mission
    r = client.post("/api/sessions", json={"trainee_id": tr["id"], "mode": "adaptive"}).json()
    assert r["session"]["mission_id"] == "familiarisation"
    sid = r["session"]["id"]
    result = play(r["scenario"], tmp_path)
    scored = client.post(f"/api/sessions/{sid}/result", json=result)
    assert scored.status_code == 200, scored.text
    assert scored.json()["report"]["grade"] == "A"

    # can't submit twice, can't submit someone else's scenario
    assert client.post(f"/api/sessions/{sid}/result", json=result).status_code == 400

    bundle = client.get(f"/api/sessions/{sid}").json()
    assert bundle["report"]["tracks"] and bundle["replay"]["frames"]
    assert all(e["type"] != "camera" for e in bundle["events"])

    d = client.get(f"/api/sessions/{sid}/debrief").json()
    assert d["source"] == "template"  # no GROQ_API_KEY in tests
    assert d["summary"] and d["next_drill"]

    # second adaptive session comes from the engine, with its reasoning
    r2 = client.post("/api/sessions", json={"trainee_id": tr["id"], "mode": "adaptive"}).json()
    assert r2["session"]["mode"] == "adaptive" and r2["session"]["mission_id"] is None
    assert "Focus" in r2["session"]["plan"]["why"]
    bad = dict(result)
    assert client.post(f"/api/sessions/{r2['session']['id']}/result", json=bad).status_code == 400

    t = client.get(f"/api/trainees/{tr['id']}/trends").json()
    assert len(t["sessions"]) == 1 and len(t["skills"]) == 8
    dash = client.get(f"/api/units/{unit['id']}/dashboard").json()
    assert dash["trainees"][0]["sessions"] == 1


def test_benchmark_is_identical_for_everyone(client):
    unit = client.post("/api/units", json={"name": "U"}).json()
    a = client.post("/api/trainees", json={"name": "A", "unit_id": unit["id"]}).json()
    b = client.post("/api/trainees", json={"name": "B", "unit_id": unit["id"]}).json()
    sa = client.post("/api/sessions", json={"trainee_id": a["id"], "mode": "benchmark"}).json()["scenario"]
    sb = client.post("/api/sessions", json={"trainee_id": b["id"], "mode": "benchmark"}).json()["scenario"]
    assert sa == sb


def test_rules_preview_and_publish(client, tmp_path):
    unit = client.post("/api/units", json={"name": "U"}).json()
    tr = client.post("/api/trainees", json={"name": "A", "unit_id": unit["id"]}).json()
    r = client.post("/api/sessions", json={"trainee_id": tr["id"], "mode": "mission", "mission_id": "night_swarm_forward_airbase", "seed": 3}).json()
    client.post(f"/api/sessions/{r['session']['id']}/result", json=play(r["scenario"], tmp_path, bot="jam_everything"))
    rules = client.get("/api/rules").json()
    assert rules["version"] == 1
    lenient = rules["yaml"].replace("then: { points: -15, tag: wasted_action }", "then: { points: 0, tag: wasted_action }")
    assert lenient != rules["yaml"]
    prev = client.post("/api/rules/preview", json={"yaml": lenient}).json()
    assert prev["ok"] and prev["rows"][0]["new_total"] > prev["rows"][0]["old_total"]
    assert client.post("/api/rules/preview", json={"yaml": "rules: [{id: X}]"}).json()["ok"] is False
    assert client.put("/api/rules", json={"yaml": "rules: [{id: X}]"}).status_code == 400
    assert client.put("/api/rules", json={"yaml": lenient, "note": "no wasted-jam penalty"}).json()["version"] == 2


def test_unknown_things_404(client):
    assert client.get("/api/trainees/TR-nope/trends").status_code == 404
    assert client.get("/api/sessions/S-nope").status_code == 404
    assert client.post("/api/sessions", json={"trainee_id": "TR-nope"}).status_code == 404
