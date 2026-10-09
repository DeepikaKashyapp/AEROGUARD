import subprocess
import sys

from conftest import ROOT

from server.content import load_catalogue
from server.contracts import Scenario


def test_generated_contracts_are_up_to_date():
    r = subprocess.run([sys.executable, "scripts/gen_contracts.py", "--check"], cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_catalogue_numbers_are_sourced_or_marked_illustrative():
    cat = load_catalogue()
    for group in (cat.drones, cat.effectors, cat.sensors):
        for key, spec in group.items():
            assert spec.illustrative or spec.source, f"{key} has neither a source nor illustrative: true"


def test_every_class_has_an_effect_row():
    cat = load_catalogue()
    for kind, row in cat.effect_matrix.items():
        assert set(row) == set(cat.drones), f"effect_matrix.{kind} must cover every drone class"


def test_sim_fixture_is_a_valid_scenario():
    Scenario.model_validate_json((ROOT / "sim/test/fixtures/basic.json").read_text())
