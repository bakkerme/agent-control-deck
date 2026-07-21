"""BLE egress: push StatusSnapshot JSON to an ACD-* deck on an interval."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Callable

import httpx
from bleak import BleakClient
from bleak.exc import BleakError

from agent_control_deck_bridge.ble_device import find_device
from agent_control_deck_bridge.ble_protocol import (
    UUID_INFO,
    UUID_STATUS_STATE,
    StateWaiter,
    push_snapshot,
)
from agent_control_deck_bridge.model import StatusSnapshot

log = logging.getLogger(__name__)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def snapshot_to_wire_bytes(snapshot: StatusSnapshot | dict[str, Any]) -> bytes:
    """Compact ASCII JSON for the deck (≤ 8 KiB)."""
    if isinstance(snapshot, StatusSnapshot):
        data = snapshot.model_dump(mode="json", exclude_none=False)
    else:
        data = snapshot
    return json.dumps(data, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


async def fetch_status_url(url: str, *, timeout: float = 5.0) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.json()


SnapshotSource = Callable[[], StatusSnapshot | dict[str, Any] | None]
# async variant
AsyncSnapshotSource = Callable[[], Any]


async def run_push_loop(
    *,
    get_snapshot: AsyncSnapshotSource,
    interval: float = 15.0,
    once: bool = False,
    max_ticks: int | None = None,
    device_name: str | None = None,
    device_address: str | None = None,
    scan_timeout: float = 12.0,
    reconnect_delay: float = 3.0,
) -> int:
    """
    Discover deck, push snapshots forever (or once).

    get_snapshot: async callable returning StatusSnapshot | dict | None.
    None → skip this tick (keep link alive without redraw if same).
    """
    tick = 0
    while True:
        found, devices = await find_device(scan_timeout, device_name, device_address)
        if found is None:
            log.error("no ACD-* device found (scan_timeout=%.1fs)", scan_timeout)
            for d in sorted(devices or [], key=lambda x: (x.name or "")):
                if d.name:
                    log.info("  seen %s  %r", d.address, d.name)
            if once:
                return 2
            await asyncio.sleep(reconnect_delay)
            continue

        log.info(
            "using device %r %s",
            getattr(found, "name", None),
            getattr(found, "address", found),
        )

        try:
            async with BleakClient(found, timeout=30.0) as client:
                mtu = getattr(client, "mtu_size", None)
                log.info("connected mtu=%s", mtu)
                try:
                    info = await client.read_gatt_char(UUID_INFO)
                    log.info("INFO: %s", info.decode("utf-8", errors="replace"))
                except BleakError as e:
                    log.warning("INFO read failed: %s", e)

                waiter = StateWaiter()
                await client.start_notify(UUID_STATUS_STATE, waiter.handler)
                try:
                    while True:
                        tick += 1
                        try:
                            snap = await get_snapshot()
                        except Exception:
                            log.exception("snapshot source failed tick=%s", tick)
                            snap = None

                        if snap is None:
                            log.warning("tick=%s empty snapshot — skip push", tick)
                        else:
                            body = snapshot_to_wire_bytes(snap)
                            schema = 1
                            if isinstance(snap, StatusSnapshot):
                                schema = int(snap.schema_version)
                            elif isinstance(snap, dict):
                                schema = int(snap.get("schema_version", 1))

                            t0 = time.perf_counter()
                            try:
                                state = await push_snapshot(
                                    client,
                                    body,
                                    schema_version=schema,
                                    state_waiter=waiter,
                                )
                            except Exception as e:
                                state = f"error:{type(e).__name__}:{e}"
                                log.exception("push failed")
                            dt_ms = (time.perf_counter() - t0) * 1000.0
                            log.info(
                                "push tick=%s bytes=%s state=%r %.1fms",
                                tick,
                                len(body),
                                state,
                                dt_ms,
                            )

                            if once or (max_ticks is not None and tick >= max_ticks):
                                return 0 if state == "ok" else 1

                        if once:
                            return 0
                        await asyncio.sleep(interval)
                finally:
                    try:
                        await client.stop_notify(UUID_STATUS_STATE)
                    except Exception:
                        pass
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("BLE connection error — will rescan")
            if once:
                return 1
            await asyncio.sleep(reconnect_delay)
