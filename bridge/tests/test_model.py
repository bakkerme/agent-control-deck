from agent_control_deck_bridge.model import (
    Session,
    SessionState,
    count_states,
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


def test_sort_done_before_running():
    """Design D: failed → question → done → working."""
    running = _s("r", SessionState.running, "2026-07-20T18:00:00Z")
    done = _s("d", SessionState.done, "2026-07-20T17:00:00Z")
    ordered = sort_sessions([running, done])
    assert ordered[0].id == "d"
    assert ordered[1].id == "r"


def test_sort_full_design_order():
    sessions = [
        _s("run", SessionState.running, "2026-07-20T18:00:00Z"),
        _s("err", SessionState.error, "2026-07-20T18:00:00Z"),
        _s("done", SessionState.done, "2026-07-20T18:00:00Z"),
        _s("wait", SessionState.waiting, "2026-07-20T18:00:00Z"),
    ]
    ordered = sort_sessions(sessions)
    assert [s.id for s in ordered] == ["err", "wait", "done", "run"]


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


def test_truncate_default_limit_is_8():
    sessions = [_s(f"id-{i}", SessionState.idle, "2026-07-20T18:00:00Z") for i in range(10)]
    top, total = truncate_sessions(sessions)
    assert total == 10
    assert len(top) == 8


def test_count_states():
    sessions = [
        _s("a", SessionState.error, "2026-07-20T18:00:00Z"),
        _s("b", SessionState.running, "2026-07-20T18:00:00Z"),
        _s("c", SessionState.running, "2026-07-20T18:00:00Z"),
    ]
    c = count_states(sessions)
    assert c.error == 1
    assert c.running == 2
    assert c.done == 0
