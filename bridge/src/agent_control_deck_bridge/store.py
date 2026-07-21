"""Per-adapter session sets + snapshot build."""

from __future__ import annotations

import logging
import socket
import threading
from typing import Iterable

from agent_control_deck_bridge import __version__
from agent_control_deck_bridge.model import (
    DEFAULT_DISPLAY_LIMIT,
    HostInfo,
    Session,
    StatusSnapshot,
    count_states,
    truncate_sessions,
    utc_now_iso,
)

log = logging.getLogger(__name__)


def default_host_name() -> str:
    name = socket.gethostname() or "host"
    return name[:32]


class SessionStore:
    """In-memory sessions_by_adapter with replace / post upsert semantics."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._by_adapter: dict[str, dict[str, Session]] = {}

    def replace_adapter(self, name: str, sessions: Iterable[Session]) -> None:
        with self._lock:
            self._by_adapter[name] = {s.id: s for s in sessions}

    def get_adapter(self, name: str) -> dict[str, Session]:
        with self._lock:
            return dict(self._by_adapter.get(name, {}))

    def upsert_post(self, sessions: Iterable[Session]) -> list[Session]:
        """Merge sessions into the post adapter set by id."""
        with self._lock:
            post = self._by_adapter.setdefault("post", {})
            out: list[Session] = []
            for s in sessions:
                post[s.id] = s
                out.append(s)
            return out

    def replace_post(self, sessions: Iterable[Session]) -> None:
        with self._lock:
            self._by_adapter["post"] = {s.id: s for s in sessions}

    def delete_post(self, session_id: str) -> bool:
        with self._lock:
            post = self._by_adapter.get("post")
            if not post or session_id not in post:
                return False
            del post[session_id]
            return True

    def all_sessions(self) -> list[Session]:
        with self._lock:
            by_id: dict[str, Session] = {}
            for name in sorted(self._by_adapter.keys()):
                for sid, session in self._by_adapter[name].items():
                    if sid in by_id:
                        log.warning(
                            "duplicate session id %r from adapter %r (keeping last)",
                            sid,
                            name,
                        )
                    by_id[sid] = session
            return list(by_id.values())

    def build_snapshot(
        self,
        *,
        host_name: str | None = None,
        bridge_version: str | None = None,
        display_limit: int = DEFAULT_DISPLAY_LIMIT,
    ) -> StatusSnapshot:
        sessions = self.all_sessions()
        top, total = truncate_sessions(sessions, display_limit=display_limit)
        return StatusSnapshot(
            schema_version=1,
            generated_at=utc_now_iso(),
            host=HostInfo(
                name=(host_name or default_host_name())[:32],
                bridge_version=(bridge_version or __version__)[:16],
            ),
            sessions=top,
            sessions_total=total,
            state_counts=count_states(sessions),
        )
