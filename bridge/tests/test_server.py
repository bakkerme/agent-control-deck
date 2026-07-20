from pathlib import Path

from fastapi.testclient import TestClient

from agent_control_deck_bridge.adapters.file_adapter import FileAdapter
from agent_control_deck_bridge.adapters.mock import MockAdapter
from agent_control_deck_bridge.adapters.post_adapter import PostAdapter
from agent_control_deck_bridge.server import create_app
from agent_control_deck_bridge.store import SessionStore


def _client(tmp_path: Path | None = None) -> TestClient:
    store = SessionStore()
    adapters = [MockAdapter(), PostAdapter(store)]
    if tmp_path is not None:
        adapters.insert(0, FileAdapter(tmp_path / "sessions.json"))
    app = create_app(store, adapters, host_name="test-host", enforce_loopback=True)
    return TestClient(app)


def test_healthz():
    c = _client()
    r = c.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_status_mock_sessions():
    c = _client()
    r = c.get("/v1/status")
    assert r.status_code == 200
    body = r.json()
    assert body["schema_version"] == 1
    assert body["host"]["name"] == "test-host"
    assert body["sessions_total"] == 3
    assert len(body["sessions"]) == 3
    # error should sort first
    assert body["sessions"][0]["state"] == "error"


def test_post_upsert_and_delete():
    c = _client()
    session = {
        "id": "post:job-1",
        "agent": "other",
        "title": "spike",
        "summary": "wire hooks",
        "state": "running",
        "updated_at": "2026-07-20T18:00:00Z",
    }
    r = c.post("/v1/sessions", json=session)
    assert r.status_code == 200
    assert r.json()["upserted"] == 1

    status = c.get("/v1/status").json()
    ids = {s["id"] for s in status["sessions"]}
    # mock has 3; display_limit 3 — post:job-1 is running so may displace idle
    assert status["sessions_total"] >= 3

    r = c.delete("/v1/sessions/post:job-1")
    assert r.status_code == 200

    r = c.delete("/v1/sessions/post:job-1")
    assert r.status_code == 404


def test_put_replace_post():
    c = _client()
    r = c.put(
        "/v1/adapters/post",
        json={
            "sessions": [
                {
                    "id": "post:only",
                    "agent": "other",
                    "title": "t",
                    "summary": "s",
                    "state": "idle",
                    "updated_at": "2026-07-20T18:00:00Z",
                }
            ]
        },
    )
    assert r.status_code == 200
    assert r.json()["count"] == 1

    r = c.put("/v1/adapters/post", json={"sessions": []})
    assert r.status_code == 200
    assert r.json()["count"] == 0


def test_grok_hook_endpoint():
    c = _client()
    r = c.post(
        "/v1/hooks/grok",
        json={
            "hookEventName": "session_start",
            "sessionId": "g-1",
            "cwd": "/Users/me/my-project",
            "source": "startup",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["action"] == "upsert"
    assert body["session"]["id"] == "post:grok:g-1"
    assert body["session"]["title"] == "my-project"


def test_claude_hook_session_end():
    c = _client()
    c.post(
        "/v1/hooks/claude",
        json={
            "hook_event_name": "SessionStart",
            "session_id": "c-1",
            "cwd": "/tmp/x",
        },
    )
    r = c.post(
        "/v1/hooks/claude",
        json={
            "hook_event_name": "SessionEnd",
            "session_id": "c-1",
        },
    )
    assert r.status_code == 200
    assert r.json()["action"] == "delete"
    assert r.json()["deleted"] is True


def test_file_adapter_in_status(tmp_path: Path):
    import json

    p = tmp_path / "sessions.json"
    p.write_text(
        json.dumps(
            [
                {
                    "id": "file:docs",
                    "agent": "other",
                    "title": "docs",
                    "summary": "from file",
                    "state": "error",
                    "updated_at": "2026-07-20T20:00:00Z",
                }
            ]
        ),
        encoding="utf-8",
    )
    store = SessionStore()
    app = create_app(
        store,
        [FileAdapter(p), PostAdapter(store)],
        host_name="test-host",
    )
    c = TestClient(app)
    body = c.get("/v1/status").json()
    assert body["sessions"][0]["id"] == "file:docs"
    assert body["sessions"][0]["summary"] == "from file"
