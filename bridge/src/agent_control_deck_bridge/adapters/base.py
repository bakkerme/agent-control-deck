"""Adapter protocol — poll() returns full session set owned by this source."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from agent_control_deck_bridge.model import Session


@runtime_checkable
class Adapter(Protocol):
    name: str

    def poll(self) -> list[Session]:
        """Return the full current session set for this adapter (replace semantics)."""
        ...
