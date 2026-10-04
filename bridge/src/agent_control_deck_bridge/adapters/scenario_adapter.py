"""Scenario adapter — multi-step session transitions for demos and tests.

Run with ``acd-bridge serve --adapter scenario:builtin:lifecycle``.
Each ``poll()`` returns the current working set and advances the hold
counter. The server polls once at startup and on every GET /v1/status.
"""

from __future__ import annotations

from pathlib import Path

from agent_control_deck_bridge.model import Session
from agent_control_deck_bridge.scenario import ScenarioDoc, ScenarioPlayer, load_scenario


class ScenarioAdapter:
    name = "scenario"

    def __init__(self, source: str | Path | ScenarioDoc) -> None:
        if isinstance(source, ScenarioDoc):
            self.doc = source
            self.source = source.name
        else:
            self.source = str(source)
            self.doc = load_scenario(source)
        self.player = ScenarioPlayer(self.doc)

    def poll(self) -> list[Session]:
        return self.player.poll()

    def peek(self) -> list[Session]:
        return self.player.peek()
