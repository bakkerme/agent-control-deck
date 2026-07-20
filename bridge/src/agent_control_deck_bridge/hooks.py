"""Map Grok Build / Claude Code hook envelopes → Session upserts / deletes."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agent_control_deck_bridge.model import Session, SessionState, utc_now_iso


@dataclass
class HookResult:
    """Action for the post adapter after processing a vendor hook event."""

    action: str  # "upsert" | "delete" | "ignore"
    session: Session | None = None
    session_id: str | None = None


def _first_str(d: dict[str, Any], *keys: str) -> str | None:
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _event_name(payload: dict[str, Any]) -> str:
    raw = _first_str(
        payload,
        "hookEventName",
        "hook_event_name",
        "event",
        "type",
    )
    if not raw:
        # Claude sometimes only sends tool_name without event; treat as tool activity
        if payload.get("tool_name") or payload.get("toolName"):
            return "post_tool_use"
        return "unknown"
    # Normalize: PreToolUse / pre_tool_use / pre-tool-use → pre_tool_use
    s = raw.replace("-", "_")
    # camelCase → snake
    out: list[str] = []
    for i, ch in enumerate(s):
        if ch.isupper() and i > 0 and (s[i - 1].islower() or (i + 1 < len(s) and s[i + 1].islower())):
            out.append("_")
        out.append(ch.lower())
    return "".join(out).lstrip("_")


def _session_id(payload: dict[str, Any], agent: str) -> str:
    sid = _first_str(payload, "sessionId", "session_id", "sessionID") or "unknown"
    # Keep under 64 chars
    raw = f"post:{agent}:{sid}"
    return raw[:64]


def _title_from_cwd(payload: dict[str, Any]) -> str:
    cwd = _first_str(payload, "cwd", "workspaceRoot", "workspace_root", "CWD")
    if not cwd:
        cwd = os.getcwd()
    name = Path(cwd).name or "workspace"
    return name[:24]


def _truncate(s: str, n: int) -> str:
    s = " ".join(s.split())
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def _tool_name(payload: dict[str, Any]) -> str | None:
    return _first_str(payload, "toolName", "tool_name")


def _prompt_text(payload: dict[str, Any]) -> str | None:
    return _first_str(payload, "prompt", "user_prompt", "userPrompt", "message")


def map_hook_event(payload: dict[str, Any], *, agent: str) -> HookResult:
    """Translate a vendor lifecycle event into a post-adapter action.

    Supported events (Grok + Claude Code common set):
      SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
      PostToolUseFailure, Stop, StopFailure, SessionEnd, Notification
    """
    event = _event_name(payload)
    sid = _session_id(payload, agent)
    title = _title_from_cwd(payload)
    now = utc_now_iso()
    tool = _tool_name(payload)

    # Session end → remove from board
    if event in {"session_end", "sessionend"}:
        return HookResult(action="delete", session_id=sid)

    state = SessionState.running
    summary = "Agent session"
    detail: str | None = None
    error: str | None = None
    progress: float | None = None

    if event in {"session_start", "sessionstart"}:
        source = _first_str(payload, "source") or "startup"
        summary = f"Session started ({source})"
        state = SessionState.running
    elif event in {"user_prompt_submit", "userpromptsubmit", "before_submit_prompt"}:
        prompt = _prompt_text(payload) or "User prompt"
        summary = _truncate(prompt, 80)
        state = SessionState.running
    elif event in {"pre_tool_use", "pretooluse"}:
        summary = f"Calling {tool or 'tool'}"
        detail = _truncate(str(payload.get("toolInput") or payload.get("tool_input") or ""), 80) or None
        state = SessionState.running
    elif event in {"post_tool_use", "posttooluse"}:
        summary = f"Used {tool or 'tool'}"
        detail = tool
        state = SessionState.running
    elif event in {"post_tool_use_failure", "posttoolusefailure", "stop_failure", "stopfailure"}:
        summary = f"Tool/API failure: {tool or 'error'}"
        state = SessionState.error
        error = _truncate(
            _first_str(payload, "error", "message", "reason") or "failure",
            80,
        )
    elif event in {"stop", "subagent_stop", "subagentstop", "subagent_end"}:
        summary = "Turn complete"
        state = SessionState.idle
    elif event in {"notification"}:
        ntype = _first_str(payload, "notificationType", "notification_type", "type") or "notify"
        summary = _truncate(f"Notification: {ntype}", 80)
        state = SessionState.waiting
    elif event in {"subagent_start", "subagentstart"}:
        summary = "Subagent running"
        state = SessionState.running
    else:
        summary = f"Event: {event}"
        state = SessionState.unknown

    # Prefer last user-visible text when present on Stop (Claude)
    last_msg = _first_str(payload, "last_assistant_message", "lastAssistantMessage")
    if last_msg and event in {"stop", "subagent_stop", "subagentstop"}:
        summary = _truncate(last_msg, 80)

    session = Session(
        id=sid,
        agent=agent[:24],
        title=title,
        summary=summary,
        state=state,
        progress=progress,
        detail=detail,
        started_at=None,
        updated_at=now,
        error=error,
    )
    return HookResult(action="upsert", session=session)
