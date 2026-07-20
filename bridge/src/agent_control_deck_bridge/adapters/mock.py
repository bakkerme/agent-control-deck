"""Synthetic sessions for demos without real agents."""

from __future__ import annotations

from agent_control_deck_bridge.model import Session, SessionState, utc_now_iso


class MockAdapter:
    name = "mock"

    def __init__(self, *, animate: bool = False) -> None:
        self._animate = animate
        self._tick = 0

    def poll(self) -> list[Session]:
        self._tick += 1
        now = utc_now_iso()
        progress = None
        summary = "Implement bridge hook ingress"
        if self._animate:
            progress = round(min(0.95, 0.1 + (self._tick % 80) / 100.0), 2)
            summary = f"Mock tick={self._tick} p={progress}"
        return [
            Session(
                id="mock:demo-1",
                agent="mock",
                title="agent-control-deck",
                summary=summary,
                state=SessionState.running,
                progress=progress if self._animate else 0.45,
                detail="bridge/ adapters + FastAPI",
                started_at=now,
                updated_at=now,
                error=None,
            ),
            Session(
                id="mock:demo-idle",
                agent="mock",
                title="docs",
                summary="No active task",
                state=SessionState.idle,
                progress=None,
                detail=None,
                started_at=None,
                updated_at=now,
                error=None,
            ),
            Session(
                id="mock:demo-err",
                agent="mock",
                title="demo",
                summary="Adapter failure",
                state=SessionState.error,
                progress=None,
                detail=None,
                started_at=now,
                updated_at=now,
                error="Simulated adapter crash",
            ),
        ]
