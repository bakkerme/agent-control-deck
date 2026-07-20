#!/usr/bin/env python3
"""
PR-S2 host: chunked StatusSnapshot push; optional 100-transfer soak.

  python push_xfer.py --count 100
  python push_xfer.py --payload payloads/mock_3sessions.json
  python push_xfer.py --payload payloads/schema_bad.json  # expect schema/ok path
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from bleak import BleakClient
from bleak.exc import BleakError

from device import find_device
from protocol import UUID_INFO, push_snapshot

HERE = Path(__file__).resolve().parent
DEFAULT_PAYLOAD = HERE / "payloads" / "mock_3sessions.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"[{utc_now()}] {msg}", flush=True)


def load_body(path: Path, *, pad_to: int | None) -> bytes:
    text = path.read_text(encoding="utf-8")
    # Validate JSON then re-serialize compact for stable size
    obj = json.loads(text)
    body = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    if pad_to is not None:
        if pad_to < len(body):
            raise SystemExit(f"--pad-to {pad_to} < payload {len(body)}")
        # Pad with spaces inside a dummy trailing field if needed — simpler: append spaces
        # (invalid for strict JSON) — use a padding string field instead.
        if pad_to > len(body):
            pad_field = "x" * max(0, pad_to - len(body) - 10)
            obj["_pad"] = pad_field
            body = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
            while len(body) < pad_to:
                obj["_pad"] = obj.get("_pad", "") + "x"
                body = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
            body = body[:pad_to] if len(body) > pad_to else body
            # Ensure still valid JSON after rare trim
            if len(body) != pad_to:
                body = body.ljust(pad_to, b" ")
    return body


async def amain(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="PR-S2 chunked BLE transfer test")
    p.add_argument("--name", help="Exact device name (default: first ACD-*)")
    p.add_argument("--address", help="BLE address")
    p.add_argument("--scan-timeout", type=float, default=12.0)
    p.add_argument("--payload", type=Path, default=DEFAULT_PAYLOAD)
    p.add_argument("--count", type=int, default=1, help="Consecutive transfers (use 100 for S2)")
    p.add_argument("--schema-version", type=int, default=None, help="Override BEGIN schema byte")
    p.add_argument("--pad-to", type=int, default=None, help="Grow JSON toward N bytes (≤8192)")
    p.add_argument("--interval", type=float, default=0.05, help="Pause between transfers")
    args = p.parse_args(argv)

    body = load_body(args.payload, pad_to=args.pad_to)
    schema = args.schema_version
    if schema is None:
        try:
            schema = int(json.loads(body.decode("utf-8")).get("schema_version", 1))
        except Exception:
            schema = 1

    log(f"payload path={args.payload} bytes={len(body)} schema={schema} count={args.count}")

    found, devices = await find_device(args.scan_timeout, args.name, args.address)
    if found is None:
        log("no device found")
        for d in sorted(devices or [], key=lambda x: (x.name or "")):
            if d.name:
                log(f"  {d.address}  {d.name!r}")
        return 2

    device = found if args.address else found
    log(f"using {getattr(device, 'name', None)!r} {getattr(device, 'address', device)}")

    ok = 0
    fail = 0
    t0 = time.perf_counter()

    async with BleakClient(device, timeout=30.0) as client:
        mtu = getattr(client, "mtu_size", None)
        log(f"connected mtu={mtu}")
        try:
            info = await client.read_gatt_char(UUID_INFO)
            log(f"INFO: {info.decode('utf-8', errors='replace')}")
        except BleakError as e:
            log(f"INFO read failed: {e}")

        for i in range(1, args.count + 1):
            start = time.perf_counter()
            try:
                state = await push_snapshot(client, body, schema_version=schema)
            except Exception as e:
                state = f"error:{type(e).__name__}"
            dt_ms = (time.perf_counter() - start) * 1000.0
            success = state == "ok" or (schema != 1 and state == "schema")
            if success:
                ok += 1
            else:
                fail += 1
            if i <= 3 or i % 10 == 0 or not success:
                log(f"xfer {i}/{args.count} state={state!r} {dt_ms:.1f}ms ok={ok} fail={fail}")
            if args.interval > 0:
                await asyncio.sleep(args.interval)

    elapsed = time.perf_counter() - t0
    log(f"done ok={ok} fail={fail} elapsed={elapsed:.2f}s mtu={mtu}")
    # S2 acceptance: 100/100 clean transfers when schema=1 and payload valid
    if args.count >= 100 and fail == 0 and ok == args.count:
        log("S2 PASS: 100/100 clean transfers")
        return 0
    if fail == 0 and ok == args.count:
        return 0
    return 1


def main() -> None:
    try:
        raise SystemExit(asyncio.run(amain()))
    except KeyboardInterrupt:
        log("interrupted")
        raise SystemExit(130)


if __name__ == "__main__":
    main()
