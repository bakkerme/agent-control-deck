"""Post adapter — sessions owned by loopback HTTP handlers."""

from __future__ import annotations

from agent_control_deck_bridge.model import Session
from agent_control_deck_bridge.store import SessionStore


class PostAdapter:
    """Views the store's post set; mutations happen via SessionStore HTTP paths."""

    name = "post"

    def __init__(self, store: SessionStore) -> None:
        self._store = store

    def poll(self) -> list[Session]:
        return list(self._store.get_adapter("post").values())
