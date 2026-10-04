"""CLI: acd-bridge serve | push-ble."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

import uvicorn

from agent_control_deck_bridge.model import DEFAULT_DISPLAY_LIMIT
from agent_control_deck_bridge.server import build_adapters_from_specs, create_app
from agent_control_deck_bridge.store import SessionStore, default_host_name


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="acd-bridge",
        description="Agent Control Deck bridge — hook ingress + BLE push to deck.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser(
        "serve",
        help="Run loopback HTTP API for hooks (default 127.0.0.1:8787)",
    )
    serve.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind address (default 127.0.0.1 — do not use 0.0.0.0 for MVP hooks)",
    )
    serve.add_argument("--port", type=int, default=8787)
    serve.add_argument(
        "--adapter",
        action="append",
        default=[],
        metavar="SPEC",
        help="Adapter: mock | mock:animate | file:PATH | scenario:PATH|builtin:NAME | post "
        "(repeatable). Default: post only. "
        "Example: --adapter mock --adapter file:./sessions.json",
    )
    serve.add_argument(
        "--host-name",
        default=None,
        help=f"host.name in snapshots (default: hostname, e.g. {default_host_name()!r})",
    )
    serve.add_argument(
        "--display-limit",
        type=int,
        default=DEFAULT_DISPLAY_LIMIT,
        help=f"Max sessions in StatusSnapshot (default {DEFAULT_DISPLAY_LIMIT})",
    )
    serve.add_argument(
        "--log-level",
        default="info",
        choices=["debug", "info", "warning", "error"],
    )
    serve.add_argument(
        "--allow-non-loopback",
        action="store_true",
        help="Disable client loopback check (debug only; still prefer bind 127.0.0.1)",
    )
    serve.add_argument(
        "--log-hooks",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Log full vendor hook JSON + mapped session (default: on). Use --no-log-hooks to quiet.",
    )

    push = sub.add_parser(
        "push-ble",
        help="Push StatusSnapshot to ACD-* deck over BLE (poll store or status URL)",
    )
    push.add_argument(
        "--from-url",
        default="http://127.0.0.1:8787/v1/status",
        help="GET this URL for snapshots (default: local acd-bridge serve)",
    )
    push.add_argument(
        "--adapter",
        action="append",
        default=[],
        metavar="SPEC",
        help="Instead of --from-url: build snapshot from local adapters "
        "(mock | mock:animate | file:PATH | scenario:PATH|builtin:NAME | post). "
        "Scenario advances one hold tick per push — good for transition demos.",
    )
    push.add_argument(
        "--host-name",
        default=None,
        help="host.name when using --adapter (default: hostname)",
    )
    push.add_argument(
        "--display-limit",
        type=int,
        default=DEFAULT_DISPLAY_LIMIT,
        help=f"Max sessions when using --adapter (default {DEFAULT_DISPLAY_LIMIT})",
    )
    push.add_argument("--interval", type=float, default=15.0, help="Seconds between pushes")
    push.add_argument("--once", action="store_true", help="Single push then exit")
    push.add_argument("--max-ticks", type=int, default=None)
    push.add_argument("--name", help="Exact BLE device name (default: first ACD-*)")
    push.add_argument("--address", help="BLE address")
    push.add_argument("--scan-timeout", type=float, default=12.0)
    push.add_argument(
        "--log-level",
        default="info",
        choices=["debug", "info", "warning", "error"],
    )
    return p


def _cmd_serve(args: argparse.Namespace) -> int:
    if args.host not in {"127.0.0.1", "localhost", "::1"} and not args.allow_non_loopback:
        print(
            f"error: refusing to bind {args.host!r} without --allow-non-loopback "
            "(hooks must stay loopback-only)",
            file=sys.stderr,
        )
        return 2

    store = SessionStore()
    specs = list(args.adapter) if args.adapter else ["post"]
    try:
        adapters = build_adapters_from_specs(specs, store)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    app = create_app(
        store,
        adapters,
        host_name=args.host_name,
        display_limit=args.display_limit,
        enforce_loopback=not args.allow_non_loopback,
        log_hooks=args.log_hooks,
    )

    print(
        f"acd-bridge listening on http://{args.host}:{args.port} "
        f"adapters={[getattr(a, 'name', '?') for a in adapters]} "
        f"display_limit={args.display_limit}",
        flush=True,
    )
    print("  GET  /healthz", flush=True)
    print("  GET  /v1/status", flush=True)
    print("  POST /v1/sessions", flush=True)
    print("  PUT  /v1/adapters/post", flush=True)
    print("  DELETE /v1/sessions/{{id}}", flush=True)
    print("  POST /v1/hooks/grok", flush=True)
    print("  POST /v1/hooks/claude", flush=True)
    print(
        "  BLE: run `acd-bridge push-ble` in another terminal to push to the deck",
        flush=True,
    )

    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


def _cmd_push_ble(args: argparse.Namespace) -> int:
    from agent_control_deck_bridge.ble_out import fetch_status_url, run_push_loop

    use_local = bool(args.adapter)
    store: SessionStore | None = None
    adapters = []

    if use_local:
        store = SessionStore()
        try:
            adapters = build_adapters_from_specs(list(args.adapter), store)
        except ValueError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        logging.getLogger(__name__).info(
            "push-ble local adapters=%s display_limit=%s",
            [getattr(a, "name", "?") for a in adapters],
            args.display_limit,
        )
    else:
        logging.getLogger(__name__).info(
            "push-ble from-url=%s interval=%s once=%s",
            args.from_url,
            args.interval,
            args.once,
        )

    async def get_snapshot():
        if use_local and store is not None:
            for adapter in adapters:
                try:
                    sessions = adapter.poll()
                except Exception:
                    logging.getLogger(__name__).exception(
                        "adapter %s poll failed", getattr(adapter, "name", "?")
                    )
                    continue
                store.replace_adapter(adapter.name, sessions)
                # Scenario demos: surface the step that was just pushed
                player = getattr(adapter, "player", None)
                if player is not None:
                    logging.getLogger(__name__).info(
                        "scenario step %s/%s %r sessions=%s finished=%s",
                        player.last_step_index + 1,
                        len(player.doc.steps),
                        player.last_label,
                        len(sessions),
                        player.finished,
                    )
            return store.build_snapshot(
                host_name=args.host_name,
                display_limit=args.display_limit,
            )
        return await fetch_status_url(args.from_url)

    return asyncio.run(
        run_push_loop(
            get_snapshot=get_snapshot,
            interval=args.interval,
            once=args.once,
            max_ticks=args.max_ticks,
            device_name=args.name,
            device_address=args.address,
            scan_timeout=args.scan_timeout,
        )
    )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.cmd == "serve":
        return _cmd_serve(args)
    if args.cmd == "push-ble":
        return _cmd_push_ble(args)

    parser.error(f"unknown command {args.cmd}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
