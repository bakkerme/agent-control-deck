"""Shared BLE UUIDs and chunk framing for deck STATUS_* characteristics.

Promoted from tools/ble_link/protocol.py for production bridge egress.
"""

from __future__ import annotations

import asyncio
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
    return struct.pack(
        "<BBHI",
        CTRL_BEGIN,
        schema_version & 0xFF,
        total_len & 0xFFFF,
        crc & 0xFFFFFFFF,
    )


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


def chunk_size_for_mtu(mtu: int | None, *, conservative: bool = True) -> int:
    """Bytes of JSON per DATA write (excludes 2-byte seq)."""
    if not mtu or mtu < 23:
        mtu = 23
    theoretical = max(1, mtu - 3 - 2)
    if conservative:
        return min(theoretical, 20)
    return min(theoretical, 180)


class StateWaiter:
    """Persistent STATE notify subscription for a connection lifetime."""

    def __init__(self) -> None:
        self._event = asyncio.Event()
        self._value: str | None = None

    def handler(self, _char, data: bytearray) -> None:
        self._value = data.decode("utf-8", errors="replace")
        self._event.set()

    def clear(self) -> None:
        self._event.clear()
        self._value = None

    async def wait(self, timeout: float) -> str:
        try:
            await asyncio.wait_for(self._event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            return "timeout"
        return self._value or "empty"


async def push_snapshot(
    client,
    body: bytes,
    *,
    schema_version: int = 1,
    state_timeout: float = 8.0,
    data_with_response: bool = True,
    chunk_max: int | None = None,
    state_waiter: StateWaiter | None = None,
    conservative_mtu: bool = True,
) -> str:
    """BEGIN → DATA* → COMMIT and return the STATUS_STATE string (e.g. 'ok')."""
    if len(body) > MAX_PAYLOAD:
        raise ValueError(f"payload {len(body)} > {MAX_PAYLOAD}")

    mtu = getattr(client, "mtu_size", None)
    if chunk_max is None:
        chunk_max = chunk_size_for_mtu(mtu, conservative=conservative_mtu)
    csum = crc32(body)

    own_waiter = state_waiter is None
    waiter = state_waiter or StateWaiter()
    if own_waiter:
        await client.start_notify(UUID_STATUS_STATE, waiter.handler)

    try:
        waiter.clear()
        await client.write_gatt_char(
            UUID_STATUS_CTRL, pack_begin(schema_version, len(body), csum), response=True
        )
        for chunk in chunk_payload(body, chunk_max):
            await client.write_gatt_char(
                UUID_STATUS_DATA, chunk, response=data_with_response
            )

        waiter.clear()
        await client.write_gatt_char(UUID_STATUS_CTRL, pack_commit(), response=True)

        state = await waiter.wait(state_timeout)
        if state == "timeout":
            try:
                raw = await client.read_gatt_char(UUID_STATUS_STATE)
                state = raw.decode("utf-8", errors="replace") or "timeout"
            except Exception:
                pass
        return state
    finally:
        if own_waiter:
            try:
                await client.stop_notify(UUID_STATUS_STATE)
            except Exception:
                pass
