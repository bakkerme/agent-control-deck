"""StatusSnapshot v1 models (schema/status.schema.json)."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator

# Retained v1 snapshot limit during the desktop transition.
DEFAULT_DISPLAY_LIMIT = 8


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class SessionState(str, Enum):
    running = "running"
    idle = "idle"
    waiting = "waiting"
    error = "error"
    done = "done"
    unknown = "unknown"


# Snapshot sort priority: lower values appear first.
STATE_PRIORITY: dict[SessionState, int] = {
    SessionState.error: 0,
    SessionState.waiting: 1,
    SessionState.unknown: 2,
    SessionState.idle: 3,
    SessionState.done: 4,
    SessionState.running: 5,
}


class HostInfo(BaseModel):
    name: str = Field(..., max_length=32)
    bridge_version: str = Field(..., max_length=16)


class StateCounts(BaseModel):
    running: int = 0
    idle: int = 0
    waiting: int = 0
    error: int = 0
    done: int = 0
    unknown: int = 0


class Session(BaseModel):
    id: str = Field(..., max_length=64)
    agent: str = Field(..., max_length=24)
    title: str = Field(..., max_length=64)
    summary: str = Field(..., max_length=120)
    state: SessionState
    progress: float | None = None
    detail: str | None = None
    started_at: str | None = None
    updated_at: str
    error: str | None = None

    @field_validator("progress")
    @classmethod
    def _progress_range(cls, v: float | None) -> float | None:
        if v is None:
            return None
        if not 0.0 <= v <= 1.0:
            raise ValueError("progress must be in [0.0, 1.0]")
        return v

    @field_validator("state", mode="before")
    @classmethod
    def _coerce_state(cls, v: Any) -> Any:
        if isinstance(v, str):
            return v.lower()
        return v


class StatusSnapshot(BaseModel):
    schema_version: int = 1
    generated_at: str
    host: HostInfo
    sessions: list[Session] = Field(default_factory=list)
    sessions_total: int | None = None
    state_counts: StateCounts | None = None


def _updated_ts(iso: str) -> float:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def sort_sessions(sessions: list[Session]) -> list[Session]:
    """Snapshot sort: state priority → newer updated_at → id asc."""
    return sorted(
        sessions,
        key=lambda s: (
            STATE_PRIORITY.get(s.state, 99),
            -_updated_ts(s.updated_at),
            s.id,
        ),
    )


def count_states(sessions: list[Session]) -> StateCounts:
    counts = StateCounts()
    for s in sessions:
        key = s.state.value
        setattr(counts, key, getattr(counts, key) + 1)
    return counts


def truncate_sessions(
    sessions: list[Session], display_limit: int = DEFAULT_DISPLAY_LIMIT
) -> tuple[list[Session], int]:
    ordered = sort_sessions(sessions)
    total = len(ordered)
    return ordered[:display_limit], total
