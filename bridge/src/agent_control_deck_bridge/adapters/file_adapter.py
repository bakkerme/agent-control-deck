"""File adapter — shell hooks write sessions.json; full replace on reload."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from agent_control_deck_bridge.model import Session

log = logging.getLogger(__name__)


class FileAdapter:
    name = "file"

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path).expanduser().resolve()
        self._mtime: float | None = None
        self._cached: list[Session] = []

    def poll(self) -> list[Session]:
        if not self.path.exists():
            self._mtime = None
            self._cached = []
            return []

        try:
            mtime = self.path.stat().st_mtime
        except OSError as e:
            log.warning("file adapter stat failed %s: %s", self.path, e)
            return list(self._cached)

        if self._mtime is not None and mtime == self._mtime:
            return list(self._cached)

        try:
            raw = self.path.read_text(encoding="utf-8")
            data = json.loads(raw) if raw.strip() else []
            sessions = self._parse(data)
        except (OSError, json.JSONDecodeError, ValidationError, TypeError) as e:
            log.warning("file adapter load failed %s: %s", self.path, e)
            # Keep last good cache on parse errors
            return list(self._cached)

        self._mtime = mtime
        self._cached = sessions
        return list(self._cached)

    def _parse(self, data: Any) -> list[Session]:
        if isinstance(data, dict):
            items = data.get("sessions", [])
        elif isinstance(data, list):
            items = data
        else:
            raise TypeError(f"expected array or object, got {type(data).__name__}")

        if not isinstance(items, list):
            raise TypeError("sessions must be a list")

        out: list[Session] = []
        for item in items:
            if not isinstance(item, dict):
                raise TypeError("each session must be an object")
            session = Session.model_validate(item)
            # Optional helper: prefix bare ids with file:
            if ":" not in session.id:
                session = session.model_copy(update={"id": f"file:{session.id}"})
            out.append(session)
        return out
