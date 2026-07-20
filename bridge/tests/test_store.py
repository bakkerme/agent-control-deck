from agent_control_deck_bridge.model import Session, SessionState
from agent_control_deck_bridge.store import SessionStore


def _s(id: str, agent: str = "mock") -> Session:
    return Session(
        id=id,
        agent=agent,
        title="t",
        summary="s",
        state=SessionState.running,
        updated_at="2026-07-20T18:00:00Z",
    )


def test_replace_and_union():
    store = SessionStore()
    store.replace_adapter("mock", [_s("mock:1")])
    store.replace_adapter("file", [_s("file:1", agent="other")])
    snap = store.build_snapshot(host_name="test-host", bridge_version="0.1.0")
    assert snap.schema_version == 1
    assert snap.host.name == "test-host"
    ids = {s.id for s in snap.sessions}
    assert ids == {"mock:1", "file:1"}
    assert snap.sessions_total == 2


def test_post_upsert_merge():
    store = SessionStore()
    store.upsert_post([_s("post:a")])
    store.upsert_post([_s("post:b")])
    store.upsert_post(
        [
            Session(
                id="post:a",
                agent="mock",
                title="t",
                summary="updated",
                state=SessionState.idle,
                updated_at="2026-07-20T19:00:00Z",
            )
        ]
    )
    post = store.get_adapter("post")
    assert set(post) == {"post:a", "post:b"}
    assert post["post:a"].summary == "updated"


def test_post_replace_clears():
    store = SessionStore()
    store.upsert_post([_s("post:a"), _s("post:b")])
    store.replace_post([])
    assert store.get_adapter("post") == {}


def test_delete_post_only():
    store = SessionStore()
    store.replace_adapter("file", [_s("file:1")])
    store.upsert_post([_s("post:a")])
    assert store.delete_post("post:a") is True
    assert store.delete_post("post:a") is False
    assert "file:1" in {s.id for s in store.all_sessions()}
