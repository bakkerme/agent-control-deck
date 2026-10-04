"""Scenario player: multi-step session transitions for session API demos.

A scenario is a sequence of steps. Each step either replaces the working
session set or patches it (upsert / remove). Hold counts how many poll()
ticks keep that step active before advancing.

Formats
-------
1. Scenario document (preferred)::

    {
      "name": "lifecycle",
      "loop": true,
      "hold": 1,
      "steps": [
        {"label": "start", "sessions": [ ... ]},
        {"label": "progress", "patch": [
          {"id": "s1", "summary": "...", "progress": 0.5},
          {"id": "s2", "op": "upsert", "agent": "grok", ...},
          {"id": "s3", "op": "remove"}
        ]},
        {"label": "from file", "file": "frames/02.json"}
      ]
    }

2. Directory of frames: ``01.json``, ``02.json``, … each a sessions array
   or full StatusSnapshot-shaped object (uses ``sessions``).

3. Builtin: ``builtin:lifecycle`` (see BUILTIN_SCENARIOS).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from agent_control_deck_bridge.model import Session, SessionState, utc_now_iso

log = logging.getLogger(__name__)

_FRAME_NAME = re.compile(r"^(\d+)[_\-.]?(.*)\.json$", re.IGNORECASE)


@dataclass
class ScenarioStep:
    label: str
    hold: int = 1
    # Exactly one of sessions / patch is applied on enter (file resolved to one of them).
    sessions: list[dict[str, Any]] | None = None
    patch: list[dict[str, Any]] | None = None


@dataclass
class ScenarioDoc:
    name: str
    loop: bool = True
    default_hold: int = 1
    steps: list[ScenarioStep] = field(default_factory=list)


def _as_positive_hold(value: Any, default: int = 1) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, n)


def _parse_sessions_payload(data: Any) -> list[dict[str, Any]]:
    """Accept full snapshot, {sessions:[...]}, or bare session array."""
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        items = data.get("sessions", [])
        if not isinstance(items, list):
            raise TypeError("sessions must be a list")
        return [item for item in items if isinstance(item, dict)]
    raise TypeError(f"expected array or object, got {type(data).__name__}")


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_scenario(source: str | Path) -> ScenarioDoc:
    """Load a scenario from path, directory, or ``builtin:name``."""
    text = str(source).strip()
    if text.startswith("builtin:"):
        name = text[len("builtin:") :].strip() or "lifecycle"
        return builtin_scenario(name)

    path = Path(text).expanduser().resolve()
    if path.is_dir():
        return load_scenario_dir(path)
    if not path.is_file():
        raise FileNotFoundError(f"scenario not found: {path}")
    raw = _load_json(path)
    if not isinstance(raw, dict) or "steps" not in raw:
        # Single snapshot file → one-step scenario
        sessions = _parse_sessions_payload(raw)
        return ScenarioDoc(
            name=path.stem,
            loop=False,
            default_hold=1,
            steps=[ScenarioStep(label=path.stem, hold=1, sessions=sessions)],
        )
    return parse_scenario_doc(raw, base_dir=path.parent, name_hint=path.stem)


def load_scenario_dir(path: Path) -> ScenarioDoc:
    frames = sorted(
        (p for p in path.iterdir() if p.is_file() and p.suffix.lower() == ".json"),
        key=_frame_sort_key,
    )
    if not frames:
        raise ValueError(f"no .json frames in scenario directory: {path}")
    steps: list[ScenarioStep] = []
    for frame in frames:
        data = _load_json(frame)
        sessions = _parse_sessions_payload(data)
        label = frame.stem
        m = _FRAME_NAME.match(frame.name)
        if m and m.group(2):
            label = m.group(2).replace("_", " ").replace("-", " ").strip() or frame.stem
        steps.append(ScenarioStep(label=label, hold=1, sessions=sessions))
    return ScenarioDoc(name=path.name, loop=True, default_hold=1, steps=steps)


def _frame_sort_key(path: Path) -> tuple[int, str]:
    m = _FRAME_NAME.match(path.name)
    if m:
        return (int(m.group(1)), path.name.lower())
    return (10**9, path.name.lower())


def parse_scenario_doc(
    raw: dict[str, Any],
    *,
    base_dir: Path,
    name_hint: str = "scenario",
) -> ScenarioDoc:
    name = str(raw.get("name") or name_hint)
    loop = bool(raw.get("loop", True))
    default_hold = _as_positive_hold(raw.get("hold", 1), 1)
    raw_steps = raw.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ValueError("scenario.steps must be a non-empty list")

    steps: list[ScenarioStep] = []
    for i, item in enumerate(raw_steps):
        if not isinstance(item, dict):
            raise TypeError(f"steps[{i}] must be an object")
        label = str(item.get("label") or f"step-{i + 1}")
        hold = _as_positive_hold(item.get("hold", default_hold), default_hold)

        sessions: list[dict[str, Any]] | None = None
        patch: list[dict[str, Any]] | None = None

        if "file" in item and item["file"] is not None:
            rel = Path(str(item["file"]))
            fpath = rel if rel.is_absolute() else (base_dir / rel)
            fpath = fpath.expanduser().resolve()
            file_data = _load_json(fpath)
            # file can be full sessions replace or a patch list under "patch"
            if isinstance(file_data, dict) and "patch" in file_data and "sessions" not in file_data:
                patch_items = file_data["patch"]
                if not isinstance(patch_items, list):
                    raise TypeError(f"{fpath}: patch must be a list")
                patch = [p for p in patch_items if isinstance(p, dict)]
            else:
                sessions = _parse_sessions_payload(file_data)
        elif "sessions" in item:
            sess = item["sessions"]
            if not isinstance(sess, list):
                raise TypeError(f"steps[{i}].sessions must be a list")
            sessions = [s for s in sess if isinstance(s, dict)]
        elif "patch" in item:
            p = item["patch"]
            if not isinstance(p, list):
                raise TypeError(f"steps[{i}].patch must be a list")
            patch = [x for x in p if isinstance(x, dict)]
        else:
            raise ValueError(
                f"steps[{i}] ({label!r}) needs sessions, patch, or file"
            )

        if sessions is None and patch is None:
            raise ValueError(f"steps[{i}] ({label!r}) has empty payload")

        steps.append(ScenarioStep(label=label, hold=hold, sessions=sessions, patch=patch))

    return ScenarioDoc(name=name, loop=loop, default_hold=default_hold, steps=steps)


def _session_from_dict(data: dict[str, Any], *, now: str) -> Session:
    payload = dict(data)
    payload.setdefault("updated_at", now)
    if "state" in payload and isinstance(payload["state"], str):
        payload["state"] = payload["state"].lower()
    return Session.model_validate(payload)


def _apply_patch(
    working: dict[str, Session],
    patch: list[dict[str, Any]],
    *,
    now: str,
) -> None:
    required = ("agent", "title", "summary", "state")
    for i, op in enumerate(patch):
        sid = op.get("id")
        if not sid or not isinstance(sid, str):
            raise ValueError(f"patch[{i}] missing string id")
        action = str(op.get("op", "upsert")).lower()
        if action == "remove":
            working.pop(sid, None)
            continue
        if action not in {"upsert", "add", "update", "replace"}:
            raise ValueError(f"patch[{i}] unknown op {action!r}")

        # Non-null fields to merge; explicit nulls clear optional Session fields.
        fields = {k: v for k, v in op.items() if k not in {"op"} and v is not None}
        fields["id"] = sid
        fields["updated_at"] = now
        null_clears = {
            k
            for k, v in op.items()
            if k not in {"op", "id"} and v is None
        }

        if action == "replace" or sid not in working:
            if action == "replace" and sid in working:
                base = working[sid].model_dump(mode="json")
                base.update(fields)
                for k in null_clears:
                    base[k] = None
                working[sid] = _session_from_dict(base, now=now)
                continue
            missing = [k for k in required if k not in fields]
            if missing:
                raise ValueError(
                    f"patch[{i}] new session {sid!r} missing fields: {missing}"
                )
            payload = dict(fields)
            for k in null_clears:
                payload[k] = None
            working[sid] = _session_from_dict(payload, now=now)
            continue

        # Partial upsert onto existing
        base = working[sid].model_dump(mode="json")
        base.update(fields)
        for k in null_clears:
            base[k] = None
        working[sid] = _session_from_dict(base, now=now)


class ScenarioPlayer:
    """Stateful stepper: each poll() returns sessions for the current step, then ticks hold."""

    def __init__(self, doc: ScenarioDoc) -> None:
        if not doc.steps:
            raise ValueError("scenario has no steps")
        self.doc = doc
        self.step_index = 0
        self.hold_remaining = 0
        self.working: dict[str, Session] = {}
        self.finished = False
        self.cycles = 0
        # last_* describe the step whose sessions were returned by the most recent poll()
        self.last_step_index = 0
        self.last_label = doc.steps[0].label
        self._enter_step(0, stamp=True)

    @property
    def current_step(self) -> ScenarioStep:
        return self.doc.steps[self.step_index]

    @property
    def label(self) -> str:
        """Label of the step currently loaded (may already be next after poll advances)."""
        return self.current_step.label

    def poll(self) -> list[Session]:
        """
        Return sessions for the current step, then consume one hold tick.

        When hold reaches 0, advance to the next step (or loop / freeze on last).
        Use ``last_label`` / ``last_step_index`` for the step that was just shown.
        """
        self.last_step_index = self.step_index
        self.last_label = self.current_step.label
        sessions = list(self.working.values())
        self._tick_hold()
        return sessions

    def peek(self) -> list[Session]:
        """Return current sessions without advancing."""
        return list(self.working.values())

    def _tick_hold(self) -> None:
        if self.finished:
            return
        self.hold_remaining -= 1
        if self.hold_remaining > 0:
            return
        next_i = self.step_index + 1
        if next_i >= len(self.doc.steps):
            if self.doc.loop:
                self.cycles += 1
                log.info(
                    "scenario %r loop → step 0 (cycle %s)",
                    self.doc.name,
                    self.cycles,
                )
                self._enter_step(0, stamp=True)
            else:
                self.finished = True
                log.info("scenario %r finished (holding last step)", self.doc.name)
                self.hold_remaining = 10**9
        else:
            self._enter_step(next_i, stamp=True)

    def _enter_step(self, index: int, *, stamp: bool) -> None:
        self.step_index = index
        step = self.doc.steps[index]
        self.hold_remaining = step.hold
        now = utc_now_iso()
        try:
            if step.sessions is not None:
                self.working = {}
                for raw in step.sessions:
                    sess = _session_from_dict(raw, now=now)
                    self.working[sess.id] = sess
            elif step.patch is not None:
                _apply_patch(self.working, step.patch, now=now)
            else:
                raise ValueError(f"step {index} has no sessions or patch")
        except (ValidationError, ValueError, TypeError) as e:
            raise ValueError(
                f"scenario {self.doc.name!r} step {index} ({step.label!r}): {e}"
            ) from e
        log.info(
            "scenario %r step %s/%s %r hold=%s sessions=%s",
            self.doc.name,
            index + 1,
            len(self.doc.steps),
            step.label,
            step.hold,
            len(self.working),
        )


# ---------------------------------------------------------------------------
# Built-in demo
# ---------------------------------------------------------------------------

def _sess(
    sid: str,
    *,
    agent: str = "mock",
    title: str,
    summary: str,
    state: str,
    progress: float | None = None,
    error: str | None = None,
    detail: str | None = None,
) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": sid,
        "agent": agent,
        "title": title,
        "summary": summary,
        "state": state,
        "updated_at": "2026-01-01T00:00:00Z",
    }
    if progress is not None:
        d["progress"] = progress
    if error is not None:
        d["error"] = error
    if detail is not None:
        d["detail"] = detail
    return d


def builtin_scenario(name: str) -> ScenarioDoc:
    key = name.strip().lower()
    if key in BUILTIN_SCENARIOS:
        return BUILTIN_SCENARIOS[key]()
    known = ", ".join(sorted(BUILTIN_SCENARIOS))
    raise ValueError(f"unknown builtin scenario {name!r}; known: {known}")


def _builtin_lifecycle() -> ScenarioDoc:
    """Realistic desk: empty → jobs appear → states flip → overflow → quiet."""
    return ScenarioDoc(
        name="lifecycle",
        loop=True,
        default_hold=2,
        steps=[
            ScenarioStep(
                label="empty desk",
                hold=2,
                sessions=[],
            ),
            ScenarioStep(
                label="first job starts",
                hold=2,
                sessions=[
                    _sess(
                        "sc:api",
                        agent="grok",
                        title="~/src/api",
                        summary="Scaffolding session API",
                        state="running",
                        progress=0.12,
                        detail="server.py",
                    ),
                ],
            ),
            ScenarioStep(
                label="second agent joins",
                hold=2,
                patch=[
                    {
                        "id": "sc:api",
                        "progress": 0.35,
                        "summary": "Implementing BEGIN/DATA/COMMIT framing",
                    },
                    {
                        "id": "sc:docs",
                        "op": "upsert",
                        "agent": "claude-code",
                        "title": "docs",
                        "summary": "Drafting status-schema notes",
                        "state": "running",
                        "progress": 0.2,
                    },
                    {
                        "id": "sc:idle-web",
                        "op": "upsert",
                        "agent": "other",
                        "title": "~/src/web",
                        "summary": "No active task",
                        "state": "idle",
                    },
                ],
            ),
            ScenarioStep(
                label="waiting on review",
                hold=2,
                patch=[
                    {
                        "id": "sc:docs",
                        "state": "waiting",
                        "summary": "Need review on schema field names",
                        "progress": None,
                    },
                    {
                        "id": "sc:api",
                        "progress": 0.62,
                        "summary": "CRC32 + STATE notify path",
                    },
                ],
            ),
            ScenarioStep(
                label="error appears",
                hold=3,
                patch=[
                    {
                        "id": "sc:api",
                        "state": "error",
                        "summary": "COMMIT CRC mismatch on large payload",
                        "error": "COMMIT CRC mismatch on large payload",
                        "progress": None,
                    },
                    {
                        "id": "sc:fix",
                        "op": "upsert",
                        "agent": "grok",
                        "title": "bridge/tests",
                        "summary": "Reproducing transfer failure",
                        "state": "running",
                        "progress": 0.4,
                    },
                ],
            ),
            ScenarioStep(
                label="recover + done",
                hold=2,
                patch=[
                    {
                        "id": "sc:api",
                        "state": "done",
                        "summary": "Fixed chunk size + retry on busy",
                        "error": None,
                        "progress": 1.0,
                    },
                    {
                        "id": "sc:fix",
                        "state": "done",
                        "summary": "100/100 soak clean",
                        "progress": 1.0,
                    },
                    {
                        "id": "sc:docs",
                        "state": "done",
                        "summary": "Schema notes merged",
                    },
                ],
            ),
            ScenarioStep(
                label="busy desk (overflow)",
                hold=3,
                sessions=[
                    _sess(
                        "sc:err-auth",
                        agent="grok",
                        title="~/src/api/auth",
                        summary="Merge conflict in middleware",
                        state="error",
                        error="Merge conflict in middleware",
                    ),
                    _sess(
                        "sc:wait-pay",
                        agent="claude-code",
                        title="~/src/services/payment",
                        summary="Stripe webhook verification unclear",
                        state="waiting",
                    ),
                    _sess(
                        "sc:wait-tf",
                        agent="other",
                        title="~/src/infra/terraform",
                        summary="Confirm S3 logging prefix policy",
                        state="waiting",
                    ),
                    _sess(
                        "sc:done-log",
                        agent="grok",
                        title="~/src/utils/logger",
                        summary="Structured JSON transport shipped",
                        state="done",
                    ),
                    _sess(
                        "sc:done-cli",
                        agent="claude-code",
                        title="~/src/cli",
                        summary="--dry-run flag validated",
                        state="done",
                    ),
                    _sess(
                        "sc:run-orders",
                        agent="grok",
                        title="~/src/api/orders",
                        summary="Integration tests on staging",
                        state="running",
                        progress=0.55,
                    ),
                    _sess(
                        "sc:run-android",
                        agent="other",
                        title="~/src/mobile/android",
                        summary="Gradle sync + native modules",
                        state="running",
                        progress=0.3,
                    ),
                    _sess(
                        "sc:run-docs",
                        agent="claude-code",
                        title="~/src/docs",
                        summary="OpenAPI static site rebuild",
                        state="running",
                        progress=0.8,
                    ),
                    _sess(
                        "sc:run-extra",
                        agent="grok",
                        title="~/src/extra",
                        summary="Should appear only in +N overflow",
                        state="running",
                        progress=0.1,
                    ),
                ],
            ),
            ScenarioStep(
                label="wind down",
                hold=2,
                sessions=[
                    _sess(
                        "sc:idle-api",
                        agent="grok",
                        title="~/src/api",
                        summary="No active task",
                        state="idle",
                    ),
                    _sess(
                        "sc:done-day",
                        agent="claude-code",
                        title="docs",
                        summary="Day's work landed",
                        state="done",
                    ),
                ],
            ),
        ],
    )


def _builtin_states() -> ScenarioDoc:
    """Cycle a single session through every state (sort order / icons)."""
    title = "state-tour"
    steps: list[ScenarioStep] = []
    for st in (
        SessionState.running,
        SessionState.waiting,
        SessionState.error,
        SessionState.done,
        SessionState.idle,
        SessionState.unknown,
    ):
        steps.append(
            ScenarioStep(
                label=f"state={st.value}",
                hold=2,
                sessions=[
                    _sess(
                        "sc:tour",
                        title=title,
                        summary=f"Session state is {st.value}",
                        state=st.value,
                        error="Simulated failure" if st == SessionState.error else None,
                        progress=0.5 if st == SessionState.running else None,
                    )
                ],
            )
        )
    return ScenarioDoc(name="states", loop=True, default_hold=2, steps=steps)


BUILTIN_SCENARIOS: dict[str, Any] = {
    "lifecycle": _builtin_lifecycle,
    "states": _builtin_states,
}
