#!/usr/bin/env python3
"""
PR-S1 host central: find ACD-* deck, connect, subscribe heartbeat, soak.

Acceptance targets (manual):
  - Stay connected ≥ 30 minutes
  - Survive host Bluetooth toggle (script reconnects)
  - Log MTU / disconnect counts for docs/ble-spike.md

macOS: grant Bluetooth to Terminal (or your IDE) on first run (TCC prompt).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from datetime import datetime, timezone

from bleak import BleakClient
from bleak.backends.characteristic import BleakGATTCharacteristic
from bleak.exc import BleakError

from device import find_device as scan_device
from protocol import UUID_HEARTBEAT, UUID_INFO, NAME_PREFIX


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"[{utc_now()}] {msg}", flush=True)


async def find_device(timeout: float, name: str | None, address: str | None):
    if address:
        log(f"using address={address}")
        return address

    log(f"scanning for {name or (NAME_PREFIX + '*')} (timeout={timeout}s)...")
    found, devices = await scan_device(timeout, name, address)
    if found is None:
        log("no matching device found. Visible names:")
        for d in sorted(devices or [], key=lambda x: (x.name or "")):
            if d.name:
                log(f"  {d.address}  {d.name!r}")
        return None

    log(f"found {getattr(found, 'name', None)!r} address={getattr(found, 'address', found)}")
    return found


async def session(
    device,
    *,
    reconnect: bool,
    max_duration_s: float | None,
) -> int:
    """Run one or more connect sessions. Returns process exit code."""
    t0 = time.monotonic()
    connect_ok = 0
    disconnects = 0
    hb_count = 0
    last_hb = ""

    def on_hb(_: BleakGATTCharacteristic, data: bytearray) -> None:
        nonlocal hb_count, last_hb
        hb_count += 1
        last_hb = data.decode("utf-8", errors="replace")
        if hb_count <= 3 or hb_count % 12 == 0:
            log(f"heartbeat #{hb_count}: {last_hb}")

    while True:
        elapsed = time.monotonic() - t0
        if max_duration_s is not None and elapsed >= max_duration_s:
            log(
                f"done elapsed={elapsed:.0f}s connects={connect_ok} "
                f"disconnects={disconnects} heartbeats={hb_count}"
            )
            return 0

        client: BleakClient | None = None
        try:
            log("connecting...")
            client = BleakClient(device, timeout=30.0)
            await client.connect()
            connect_ok += 1
            mtu = getattr(client, "mtu_size", None)
            log(f"connected mtu={mtu} address={client.address}")

            try:
                info = await client.read_gatt_char(UUID_INFO)
                log(f"INFO: {info.decode('utf-8', errors='replace')}")
            except BleakError as e:
                log(f"INFO read failed: {e}")

            await client.start_notify(UUID_HEARTBEAT, on_hb)
            log("subscribed HEARTBEAT — soak until disconnect or --duration")

            while client.is_connected:
                await asyncio.sleep(1.0)
                if max_duration_s is not None and (time.monotonic() - t0) >= max_duration_s:
                    log("duration reached; disconnecting cleanly")
                    break

            disconnects += 1
            log(
                f"disconnected connects={connect_ok} disconnects={disconnects} "
                f"heartbeats={hb_count} last_hb={last_hb!r}"
            )

        except asyncio.CancelledError:
            raise
        except Exception as e:
            disconnects += 1
            log(f"session error: {type(e).__name__}: {e}")
        finally:
            if client is not None:
                try:
                    if client.is_connected:
                        await client.disconnect()
                except Exception:
                    pass

        if not reconnect:
            return 1 if connect_ok == 0 else 0

        log("reconnect in 3s (toggle host BT to exercise recovery)...")
        await asyncio.sleep(3.0)


async def amain(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="PR-S1 BLE link soak test (bleak central)")
    p.add_argument("--name", help="Exact device name (default: first ACD-*)")
    p.add_argument("--address", help="Connect by BLE address (skip scan name match)")
    p.add_argument("--scan-timeout", type=float, default=12.0, help="Scan timeout seconds")
    p.add_argument(
        "--duration",
        type=float,
        default=None,
        help="Total soak seconds (default: run until Ctrl-C). Use 1800 for 30 min acceptance.",
    )
    p.add_argument(
        "--no-reconnect",
        action="store_true",
        help="Exit after first disconnect instead of reconnecting",
    )
    args = p.parse_args(argv)

    device = await find_device(args.scan_timeout, args.name, args.address)
    if device is None:
        return 2

    try:
        return await session(
            device,
            reconnect=not args.no_reconnect,
            max_duration_s=args.duration,
        )
    except KeyboardInterrupt:
        log("interrupted")
        return 130


def main() -> None:
    try:
        raise SystemExit(asyncio.run(amain()))
    except KeyboardInterrupt:
        log("interrupted")
        raise SystemExit(130)


if __name__ == "__main__":
    main()
