#!/usr/bin/env python3
"""
PR-S2 host: chunked StatusSnapshot push; optional 100-transfer soak.

  python push_xfer.py --count 100
  python push_xfer.py --payload payloads/mock_3sessions.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from bleak import BleakClient
from bleak.exc import BleakError

from device import find_device
from protocol import (
    UUID_INFO,
    UUID_STATUS_STATE,
    StateWaiter,
    chunk_size_for_mtu,
    push_snapshot,
)

HERE = Path(__file__).resolve().parent
DEFAULT_PAYLOAD = HERE / "payloads" / "mock_3sessions.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"[{utc_now()}] {msg}", flush=True)


def load_body(path: Path, *, pad_to: int | None) -> bytes:
    text = path.read_text(encoding="utf-8")
    obj = json.loads(text)
    body = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    if pad_to is not None:
        if pad_to < len(body):
            raise SystemExit(f"--pad-to {pad_to} < payload {len(body)}")
        if pad_to > len(body):
            obj["_pad"] = ""
            while True:
                body = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
                if len(body) >= pad_to:
                    break
                need = pad_to - len(body)
                obj["_pad"] = obj.get("_pad", "") + ("x" * max(need, 1))
            body = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
            if len(body) > pad_to:
                # Trim pad field
                while len(body) > pad_to and obj["_pad"]:
                    obj["_pad"] = obj["_pad"][:-1]
                    body = json.dumps(obj, separators=(",", ":"), ensure_ascii=True).encode(
                        "utf-8"
                    )
    return body


def is_success(state: str, schema: int) -> bool:
    if state == "ok":
        return True
    if schema != 1 and state == "schema":
        return True
    return False


async def amain(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="PR-S2 chunked BLE transfer test")
    p.add_argument("--name", help="Exact device name (default: first ACD-*)")
    p.add_argument("--address", help="BLE address")
    p.add_argument("--scan-timeout", type=float, default=12.0)
    p.add_argument("--payload", type=Path, default=DEFAULT_PAYLOAD)
    p.add_argument("--count", type=int, default=1, help="Consecutive transfers (use 100 for S2)")
    p.add_argument("--schema-version", type=int, default=None, help="Override BEGIN schema byte")
    p.add_argument("--pad-to", type=int, default=None, help="Grow JSON toward N bytes (≤8192)")
    p.add_argument(
        "--interval",
        type=float,
        default=0.15,
        help="Pause between transfers (default 0.15s)",
    )
    p.add_argument(
        "--chunk",
        type=int,
        default=None,
        help="Override DATA payload bytes per chunk (default: conservative from MTU)",
    )
    p.add_argument(
        "--fast-chunks",
        action="store_true",
        help="Use larger MTU-based chunks (less reliable on some hosts)",
    )
    p.add_argument(
        "--write-cmd",
        action="store_true",
        help="Use write-without-response for DATA (faster, less reliable)",
    )
    p.add_argument(
        "--retries",
        type=int,
        default=2,
        help="Retries per transfer on busy/timeout (default 2)",
    )
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

    log(f"using {getattr(found, 'name', None)!r} {getattr(found, 'address', found)}")

    ok = 0
    fail = 0
    reasons: Counter[str] = Counter()
    t0 = time.perf_counter()

    async with BleakClient(found, timeout=30.0) as client:
        mtu = getattr(client, "mtu_size", None)
        chunk = args.chunk
        if chunk is None:
            chunk = chunk_size_for_mtu(mtu, conservative=not args.fast_chunks)
        log(f"connected mtu={mtu} chunk_payload={chunk} data_response={not args.write_cmd}")
        try:
            info = await client.read_gatt_char(UUID_INFO)
            log(f"INFO: {info.decode('utf-8', errors='replace')}")
        except BleakError as e:
            log(f"INFO read failed: {e}")

        waiter = StateWaiter()
        await client.start_notify(UUID_STATUS_STATE, waiter.handler)
        try:
            for i in range(1, args.count + 1):
                start = time.perf_counter()
                state = "error"
                attempts = 1 + max(0, args.retries)
                for attempt in range(attempts):
                    try:
                        state = await push_snapshot(
                            client,
                            body,
                            schema_version=schema,
                            data_with_response=not args.write_cmd,
                            chunk_max=chunk,
                            state_waiter=waiter,
                            conservative_mtu=not args.fast_chunks,
                        )
                    except Exception as e:
                        state = f"error:{type(e).__name__}"
                    if is_success(state, schema):
                        break
                    if state in ("busy", "timeout") and attempt + 1 < attempts:
                        await asyncio.sleep(0.2 * (attempt + 1))
                        continue
                    break

                dt_ms = (time.perf_counter() - start) * 1000.0
                if is_success(state, schema):
                    ok += 1
                else:
                    fail += 1
                    reasons[state] += 1
                if i <= 5 or i % 10 == 0 or not is_success(state, schema):
                    log(
                        f"xfer {i}/{args.count} state={state!r} {dt_ms:.1f}ms "
                        f"ok={ok} fail={fail}"
                    )
                if args.interval > 0:
                    await asyncio.sleep(args.interval)
        finally:
            try:
                await client.stop_notify(UUID_STATUS_STATE)
            except Exception:
                pass

    elapsed = time.perf_counter() - t0
    log(f"done ok={ok} fail={fail} elapsed={elapsed:.2f}s mtu={mtu} chunk={chunk}")
    if reasons:
        log("fail reasons: " + ", ".join(f"{k}={v}" for k, v in reasons.most_common()))
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
