"""Shared BLE UUIDs and chunk framing for deck STATUS_* characteristics."""

from __future__ import annotations

import struct
import zlib
from typing import Iterable

# Must match deck/src/ble_gatt.h
UUID_STATUS_SERVICE = "a0cd0001-acd0-4c00-9c00-00805f9b34fb"
UUID_HEARTBEAT = "a0cd0002-acd0-4c00-9c00-00805f9b34fb"
UUID_INFO = "a0cd0003-acd0-4c00-9c00-00805f9b34fb"
UUID_STATUS_CTRL = "a0cd0010-acd0-4c00-9c00-00805f9b34fb"
UUID_STATUS_DATA = "a0cd0011-acd0-4c00-9c00-00805f9b34fb"
UUID_STATUS_STATE = "a0cd0012-acd0-4c00-9c00-00805f9b34fb"

NAME_PREFIX = "ACD-"

CTRL_BEGIN = 0x01
CTRL_ABORT = 0x02
CTRL_COMMIT = 0x03

MAX_PAYLOAD = 8192


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def pack_begin(schema_version: int, total_len: int, crc: int) -> bytes:
    if total_len < 0 or total_len > 0xFFFF:
        raise ValueError("total_len out of u16 range")
    return struct.pack("<BBHI", CTRL_BEGIN, schema_version & 0xFF, total_len & 0xFFFF, crc & 0xFFFFFFFF)


def pack_abort() -> bytes:
    return bytes([CTRL_ABORT])


def pack_commit() -> bytes:
    return bytes([CTRL_COMMIT])


def pack_data_chunk(seq: int, payload: bytes) -> bytes:
    return struct.pack("<H", seq & 0xFFFF) + payload


def chunk_payload(data: bytes, chunk_payload_max: int) -> Iterable[bytes]:
    if chunk_payload_max < 1:
        raise ValueError("chunk_payload_max must be >= 1")
    seq = 0
    offset = 0
    while offset < len(data):
        piece = data[offset : offset + chunk_payload_max]
        yield pack_data_chunk(seq, piece)
        seq += 1
        offset += len(piece)


def chunk_size_for_mtu(mtu: int | None) -> int:
    """ATT write payload budget: MTU - 3 (opcode+handle) - 2 (seq)."""
    if not mtu or mtu < 23:
        mtu = 23
    # Leave headroom for stacks that under-report usable write size.
    usable = max(20, mtu - 3 - 2 - 4)
    return min(usable, 512)


async def push_snapshot(
    client,
    body: bytes,
    *,
    schema_version: int = 1,
    state_timeout: float = 10.0,
    data_with_response: bool = True,
) -> str:
    """
    BEGIN → DATA* → COMMIT and return the STATUS_STATE notify string (e.g. 'ok').

    Default DATA writes use ATT Write Request (response=True) for reliability
    on the 100/100 S2 soak; pass data_with_response=False for write-cmd throughput.
    """
    import asyncio

    if len(body) > MAX_PAYLOAD:
        raise ValueError(f"payload {len(body)} > {MAX_PAYLOAD}")

    mtu = getattr(client, "mtu_size", None)
    chunk_max = chunk_size_for_mtu(mtu)
    csum = crc32(body)

    state_holder: dict[str, str | None] = {"value": None}
    event = asyncio.Event()

    def on_state(_char, data: bytearray) -> None:
        state_holder["value"] = data.decode("utf-8", errors="replace")
        event.set()

    await client.start_notify(UUID_STATUS_STATE, on_state)
    try:
        event.clear()
        state_holder["value"] = None
        await client.write_gatt_char(
            UUID_STATUS_CTRL, pack_begin(schema_version, len(body), csum), response=True
        )
        for chunk in chunk_payload(body, chunk_max):
            await client.write_gatt_char(
                UUID_STATUS_DATA, chunk, response=data_with_response
            )
        event.clear()
        state_holder["value"] = None
        await client.write_gatt_char(UUID_STATUS_CTRL, pack_commit(), response=True)

        try:
            await asyncio.wait_for(event.wait(), timeout=state_timeout)
        except asyncio.TimeoutError:
            return "timeout"
        return state_holder["value"] or "empty"
    finally:
        try:
            await client.stop_notify(UUID_STATUS_STATE)
        except Exception:
            pass
