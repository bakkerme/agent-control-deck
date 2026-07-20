#!/usr/bin/env python3
"""
PR-S3/S4 thin bridge: build mock StatusSnapshot and push over BLE on an interval.

  # Push forever every 15s (kill process → deck should go STALE within ~30s)
  python mock_bridge.py

  # One-shot on-glass update
  python mock_bridge.py --once

  # Mutate progress each tick so the glass redraws
  python mock_bridge.py --animate
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from bleak import BleakClient
from bleak.exc import BleakError

from device import find_device
from protocol import UUID_INFO, UUID_STATUS_STATE, StateWaiter, push_snapshot

HERE = Path(__file__).resolve().parent
DEFAULT_PAYLOAD = HERE / "payloads" / "mock_3sessions.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"[{utc_now()}] {msg}", flush=True)


def load_template(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def render_snapshot(template: dict, *, tick: int, animate: bool) -> bytes:
    snap = copy.deepcopy(template)
    snap["generated_at"] = utc_now()
    snap.setdefault("host", {})["bridge_version"] = "0.1.0-s4"
    sessions = snap.get("sessions") or []
    if animate and sessions:
        # Bump progress on first running session
        for s in sessions:
            if s.get("state") == "running":
                base = 0.1 + (tick % 80) / 100.0
                s["progress"] = round(min(0.95, base), 2)
                s["summary"] = f"Spike push tick={tick} p={s['progress']}"
                s["updated_at"] = utc_now()
                break
        else:
            sessions[0]["summary"] = f"Spike push tick={tick}"
            sessions[0]["updated_at"] = utc_now()
    return json.dumps(snap, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


async def run_loop(
    device,
    template: dict,
    *,
    interval: float,
    once: bool,
    animate: bool,
    max_ticks: int | None,
) -> int:
    tick = 0
    async with BleakClient(device, timeout=30.0) as client:
        mtu = getattr(client, "mtu_size", None)
        log(f"connected mtu={mtu}")
        try:
            info = await client.read_gatt_char(UUID_INFO)
            log(f"INFO: {info.decode('utf-8', errors='replace')}")
        except BleakError as e:
            log(f"INFO read failed: {e}")

        waiter = StateWaiter()
        await client.start_notify(UUID_STATUS_STATE, waiter.handler)
        try:
            while True:
                tick += 1
                body = render_snapshot(template, tick=tick, animate=animate)
                t0 = time.perf_counter()
                try:
                    state = await push_snapshot(
                        client,
                        body,
                        schema_version=int(template.get("schema_version", 1)),
                        state_waiter=waiter,
                    )
                except Exception as e:
                    state = f"error:{type(e).__name__}:{e}"
                dt_ms = (time.perf_counter() - t0) * 1000.0
                log(f"push tick={tick} bytes={len(body)} state={state!r} {dt_ms:.1f}ms")

                if once or (max_ticks is not None and tick >= max_ticks):
                    return 0 if state == "ok" else 1

                await asyncio.sleep(interval)
        finally:
            try:
                await client.stop_notify(UUID_STATUS_STATE)
            except Exception:
                pass


async def amain(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="PR-S3/S4 mock BLE push bridge")
    p.add_argument("--name")
    p.add_argument("--address")
    p.add_argument("--scan-timeout", type=float, default=12.0)
    p.add_argument("--payload", type=Path, default=DEFAULT_PAYLOAD)
    p.add_argument("--interval", type=float, default=15.0, help="Seconds between pushes")
    p.add_argument("--once", action="store_true", help="Single push then exit")
    p.add_argument("--animate", action="store_true", help="Change progress/summary each tick")
    p.add_argument("--max-ticks", type=int, default=None)
    args = p.parse_args(argv)

    template = load_template(args.payload)
    found, devices = await find_device(args.scan_timeout, args.name, args.address)
    if found is None:
        log("no device found")
        for d in sorted(devices or [], key=lambda x: (x.name or "")):
            if d.name:
                log(f"  {d.address}  {d.name!r}")
        return 2

    log(f"using {getattr(found, 'name', None)!r} {getattr(found, 'address', found)}")
    log("kill this process to exercise deck STALE grace (~30s)")

    try:
        return await run_loop(
            found,
            template,
            interval=args.interval,
            once=args.once,
            animate=args.animate,
            max_ticks=args.max_ticks,
        )
    except KeyboardInterrupt:
        log("interrupted (deck should go STALE if grace elapses without further pushes)")
        return 130


def main() -> None:
    try:
        raise SystemExit(asyncio.run(amain()))
    except KeyboardInterrupt:
        log("interrupted")
        raise SystemExit(130)


if __name__ == "__main__":
    main()
