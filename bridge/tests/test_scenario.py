"""Scenario player + adapter tests (no BLE)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_control_deck_bridge.adapters.scenario_adapter import ScenarioAdapter
from agent_control_deck_bridge.model import SessionState
from agent_control_deck_bridge.scenario import (
    ScenarioDoc,
    ScenarioPlayer,
    ScenarioStep,
    load_scenario,
)
from agent_control_deck_bridge.server import build_adapters_from_specs
from agent_control_deck_bridge.store import SessionStore


EXAMPLES = Path(__file__).resolve().parents[1] / "examples" / "scenarios"


def test_builtin_lifecycle_advances_and_loops():
    player = ScenarioPlayer(load_scenario("builtin:lifecycle"))
    assert player.label == "empty desk"
    assert player.poll() == []
    assert player.last_label == "empty desk"

    # hold=2 on empty → second poll still empty, then advances
    assert player.poll() == []
    assert player.last_label == "empty desk"
    sessions = player.poll()
    assert player.last_label == "first job starts"
    assert len(sessions) == 1
    assert sessions[0].id == "sc:api"
    assert sessions[0].state == SessionState.running


def test_patch_upsert_remove_and_null_clear():
    doc = ScenarioDoc(
        name="patchy",
        loop=False,
        steps=[
            ScenarioStep(
                label="seed",
                hold=1,
                sessions=[
                    {
                        "id": "a",
                        "agent": "mock",
                        "title": "t",
                        "summary": "s",
                        "state": "running",
                        "progress": 0.4,
                        "updated_at": "2026-07-21T12:00:00Z",
                    }
                ],
            ),
            ScenarioStep(
                label="mutate",
                hold=1,
                patch=[
                    {
                        "id": "a",
                        "state": "error",
                        "summary": "boom",
                        "error": "boom",
                        "progress": None,
                    },
                    {
                        "id": "b",
                        "op": "upsert",
                        "agent": "grok",
                        "title": "other",
                        "summary": "joined",
                        "state": "idle",
                    },
                ],
            ),
            ScenarioStep(
                label="drop b",
                hold=1,
                patch=[{"id": "b", "op": "remove"}],
            ),
        ],
    )
    player = ScenarioPlayer(doc)
    s0 = player.poll()
    assert len(s0) == 1
    assert s0[0].progress == 0.4

    s1 = player.poll()
    by_id = {s.id: s for s in s1}
    assert by_id["a"].state == SessionState.error
    assert by_id["a"].progress is None
    assert by_id["a"].error == "boom"
    assert "b" in by_id

    s2 = player.poll()
    assert [s.id for s in s2] == ["a"]
    # hold=1 on last step → finished after that tick
    assert player.finished is True
    # stays on last frame
    assert [s.id for s in player.poll()] == ["a"]


def test_load_json_scenario_file():
    doc = load_scenario(EXAMPLES / "lifecycle.json")
    assert doc.name == "lifecycle"
    assert len(doc.steps) >= 5
    player = ScenarioPlayer(doc)
    assert player.poll() == []


def test_load_frames_directory():
    doc = load_scenario(EXAMPLES / "frames")
    assert doc.loop is True
    assert len(doc.steps) == 4
    player = ScenarioPlayer(doc)
    assert player.poll() == []  # empty
    s = player.poll()
    assert len(s) == 1
    assert s[0].id == "frame:job-1"


def test_scenario_adapter_spec_builtin():
    store = SessionStore()
    adapters = build_adapters_from_specs(["scenario:builtin:states"], store)
    names = [a.name for a in adapters]
    assert "scenario" in names
    assert "post" in names  # always attached
    scenario = next(a for a in adapters if a.name == "scenario")
    assert isinstance(scenario, ScenarioAdapter)
    sessions = scenario.poll()
    assert len(sessions) == 1
    assert sessions[0].state == SessionState.running


def test_unknown_builtin():
    with pytest.raises(ValueError, match="unknown builtin"):
        load_scenario("builtin:nope")


def test_new_session_patch_requires_fields():
    doc = ScenarioDoc(
        name="bad",
        loop=False,
        steps=[
            ScenarioStep(label="empty", hold=1, sessions=[]),
            ScenarioStep(
                label="bad patch",
                hold=1,
                patch=[{"id": "x", "summary": "incomplete"}],
            ),
        ],
    )
    player = ScenarioPlayer(doc)
    # hold=1 on empty → first poll advances into the bad patch step
    with pytest.raises(ValueError, match="missing fields"):
        player.poll()


def test_single_snapshot_file_as_one_step(tmp_path: Path):
    p = tmp_path / "one.json"
    p.write_text(
        json.dumps(
            {
                "sessions": [
                    {
                        "id": "solo",
                        "agent": "mock",
                        "title": "t",
                        "summary": "s",
                        "state": "idle",
                        "updated_at": "2026-07-21T12:00:00Z",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    doc = load_scenario(p)
    assert doc.loop is False
    assert len(doc.steps) == 1
    assert ScenarioPlayer(doc).poll()[0].id == "solo"
