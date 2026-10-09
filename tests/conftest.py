import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.contracts import Scenario, SessionResult  # noqa: E402
from server.generator import list_missions, scripted  # noqa: E402

BOTS = ["oracle", "passive", "missile_everything", "jam_everything", "trigger_happy"]


def run_bot(bot: str, scenario: Scenario, tmp: Path, extra: list[str] | None = None) -> SessionResult:
    sp = tmp / f"{scenario.id}.json"
    sp.write_text(scenario.model_dump_json())
    out = tmp / f"{scenario.id}.{bot}.json"
    subprocess.run(
        ["node", "bots/src/cli.ts", "--bot", bot, "--scenario", str(sp), "--out", str(out), "--no-replay", *(extra or [])],
        cwd=ROOT, check=True, capture_output=True,
    )
    return SessionResult.model_validate_json(out.read_text())


@pytest.fixture(scope="session")
def bot_runs(tmp_path_factory) -> dict[tuple[str, str], tuple[Scenario, SessionResult]]:
    """Every baseline bot over every scripted mission (seed 7), run once per test session."""
    tmp = tmp_path_factory.mktemp("bots")
    runs = {}
    for m in list_missions():
        sc = scripted(m["id"], seed=7)
        for bot in BOTS:
            runs[(m["id"], bot)] = (sc, run_bot(bot, sc, tmp))
    return runs


@pytest.fixture
def load_json():
    return lambda p: json.loads(Path(p).read_text())
