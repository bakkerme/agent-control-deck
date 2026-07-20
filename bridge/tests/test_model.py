from agent_control_deck_bridge.model import (
    Session,
    SessionState,
    sort_sessions,
    truncate_sessions,
)


def _s(id: str, state: SessionState, updated: str) -> Session:
    return Session(
        id=id,
        agent="mock",
        title="t",
        summary="s",
        state=state,
        updated_at=updated,
    )


def test_sort_error_before_running():
    a = _s("a", SessionState.running, "2026-07-20T18:00:00Z")
    b = _s("b", SessionState.error, "2026-07-20T17:00:00Z")
    ordered = sort_sessions([a, b])
    assert ordered[0].id == "b"


def test_sort_newer_updated_first_same_state():
    older = _s("a", SessionState.running, "2026-07-20T17:00:00Z")
    newer = _s("b", SessionState.running, "2026-07-20T18:00:00Z")
    ordered = sort_sessions([older, newer])
    assert ordered[0].id == "b"


def test_truncate_sets_total():
    sessions = [
        _s(f"id-{i}", SessionState.idle, f"2026-07-20T18:0{i}:00Z") for i in range(5)
    ]
    top, total = truncate_sessions(sessions, display_limit=3)
    assert total == 5
    assert len(top) == 3
