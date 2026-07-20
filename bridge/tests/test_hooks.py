from agent_control_deck_bridge.hooks import map_hook_event
from agent_control_deck_bridge.model import SessionState


def test_grok_session_start():
    r = map_hook_event(
        {
            "hookEventName": "session_start",
            "sessionId": "abc-123",
            "cwd": "/Users/me/sources/agent-control-deck",
            "source": "startup",
        },
        agent="grok",
    )
    assert r.action == "upsert"
    assert r.session is not None
    assert r.session.id == "post:grok:abc-123"
    assert r.session.agent == "grok"
    assert r.session.title == "agent-control-deck"
    assert r.session.state == SessionState.running
    assert "started" in r.session.summary.lower()


def test_claude_user_prompt():
    r = map_hook_event(
        {
            "hook_event_name": "UserPromptSubmit",
            "session_id": "sess-9",
            "cwd": "/tmp/proj",
            "prompt": "Fix the BLE CRC check and add tests",
        },
        agent="claude-code",
    )
    assert r.action == "upsert"
    assert r.session is not None
    assert r.session.id.startswith("post:claude-code:")
    assert "BLE CRC" in r.session.summary
    assert r.session.state == SessionState.running


def test_session_end_deletes():
    r = map_hook_event(
        {"hookEventName": "SessionEnd", "sessionId": "x"},
        agent="grok",
    )
    assert r.action == "delete"
    assert r.session_id == "post:grok:x"


def test_stop_idle():
    r = map_hook_event(
        {
            "hookEventName": "Stop",
            "sessionId": "s1",
            "cwd": "/tmp/p",
            "last_assistant_message": "All tests passed.",
        },
        agent="claude-code",
    )
    assert r.action == "upsert"
    assert r.session is not None
    assert r.session.state == SessionState.idle
    assert "tests passed" in r.session.summary.lower()


def test_post_tool_use_failure_error():
    r = map_hook_event(
        {
            "hookEventName": "PostToolUseFailure",
            "sessionId": "s1",
            "cwd": "/tmp/p",
            "toolName": "Bash",
            "error": "exit 1",
        },
        agent="grok",
    )
    assert r.session is not None
    assert r.session.state == SessionState.error
    assert r.session.error is not None
