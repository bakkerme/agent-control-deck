"""CLI: acd-bridge serve — loopback hook ingress."""

from __future__ import annotations

import argparse
import logging
import sys

import uvicorn

from agent_control_deck_bridge.server import build_adapters_from_specs, create_app
from agent_control_deck_bridge.store import SessionStore, default_host_name


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="acd-bridge",
        description="Agent Control Deck bridge — hook ingress (loopback HTTP + file).",
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
        help="Adapter: mock | mock:animate | file:PATH | post (repeatable). "
        "Default: post only. Example: --adapter mock --adapter file:./sessions.json",
    )
    serve.add_argument(
        "--host-name",
        default=None,
        help=f"host.name in snapshots (default: hostname, e.g. {default_host_name()!r})",
    )
    serve.add_argument(
        "--display-limit",
        type=int,
        default=3,
        help="Max sessions in StatusSnapshot (default 3)",
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
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.cmd != "serve":
        parser.error(f"unknown command {args.cmd}")

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

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
        f"adapters={[getattr(a, 'name', '?') for a in adapters]}",
        flush=True,
    )
    print("  GET  /healthz", flush=True)
    print("  GET  /v1/status", flush=True)
    print("  POST /v1/sessions", flush=True)
    print("  PUT  /v1/adapters/post", flush=True)
    print("  DELETE /v1/sessions/{{id}}", flush=True)
    print("  POST /v1/hooks/grok", flush=True)
    print("  POST /v1/hooks/claude", flush=True)

    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
