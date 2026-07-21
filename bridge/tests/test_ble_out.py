"""Unit tests for BLE wire encoding (no hardware)."""

from agent_control_deck_bridge.ble_out import snapshot_to_wire_bytes
from agent_control_deck_bridge.ble_protocol import (
    MAX_PAYLOAD,
    chunk_payload,
    crc32,
    pack_begin,
    pack_commit,
)
from agent_control_deck_bridge.model import HostInfo, Session, SessionState, StatusSnapshot


def test_snapshot_to_wire_is_compact():
    snap = StatusSnapshot(
        schema_version=1,
        generated_at="2026-07-21T12:00:00Z",
        host=HostInfo(name="host", bridge_version="0.1.0"),
        sessions=[
            Session(
                id="a",
                agent="mock",
                title="t",
                summary="s",
                state=SessionState.running,
                updated_at="2026-07-21T12:00:00Z",
            )
        ],
        sessions_total=1,
    )
    body = snapshot_to_wire_bytes(snap)
    assert len(body) < MAX_PAYLOAD
    assert b" " not in body or b": " not in body  # compact separators
    assert b'"schema_version":1' in body


def test_chunk_framing():
    body = b'{"schema_version":1}'
    begin = pack_begin(1, len(body), crc32(body))
    assert len(begin) == 8
    assert begin[0] == 0x01
    chunks = list(chunk_payload(body, 8))
    assert len(chunks) >= 1
    assert pack_commit() == bytes([0x03])
