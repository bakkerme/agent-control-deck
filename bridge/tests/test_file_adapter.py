import json
from pathlib import Path

from agent_control_deck_bridge.adapters.file_adapter import FileAdapter


def test_load_array(tmp_path: Path):
    p = tmp_path / "sessions.json"
    p.write_text(
        json.dumps(
            [
                {
                    "id": "docs",
                    "agent": "other",
                    "title": "docs",
                    "summary": "hi",
                    "state": "idle",
                    "updated_at": "2026-07-20T17:00:00Z",
                }
            ]
        ),
        encoding="utf-8",
    )
    adapter = FileAdapter(p)
    sessions = adapter.poll()
    assert len(sessions) == 1
    assert sessions[0].id == "file:docs"  # bare id prefixed


def test_load_object_shape(tmp_path: Path):
    p = tmp_path / "sessions.json"
    p.write_text(
        json.dumps(
            {
                "sessions": [
                    {
                        "id": "file:keep",
                        "agent": "other",
                        "title": "x",
                        "summary": "y",
                        "state": "running",
                        "updated_at": "2026-07-20T17:00:00Z",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    sessions = FileAdapter(p).poll()
    assert sessions[0].id == "file:keep"


def test_missing_file_clears():
    adapter = FileAdapter("/nonexistent/path/sessions.json")
    assert adapter.poll() == []


def test_mtime_cache(tmp_path: Path):
    p = tmp_path / "sessions.json"
    p.write_text("[]", encoding="utf-8")
    adapter = FileAdapter(p)
    assert adapter.poll() == []
    p.write_text(
        json.dumps(
            [
                {
                    "id": "file:a",
                    "agent": "other",
                    "title": "t",
                    "summary": "s",
                    "state": "idle",
                    "updated_at": "2026-07-20T17:00:00Z",
                }
            ]
        ),
        encoding="utf-8",
    )
    # force mtime change
    import os
    import time

    time.sleep(0.05)
    os.utime(p, None)
    sessions = adapter.poll()
    assert len(sessions) == 1
