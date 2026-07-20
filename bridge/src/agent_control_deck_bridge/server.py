"""Loopback-only FastAPI surface for hooks and debug status."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from agent_control_deck_bridge.adapters.base import Adapter
from agent_control_deck_bridge.hooks import map_hook_event
from agent_control_deck_bridge.model import Session, StatusSnapshot
from agent_control_deck_bridge.store import SessionStore

log = logging.getLogger(__name__)

LOOPBACK = {"127.0.0.1", "::1", "localhost", "testclient"}


class AppState:
    def __init__(
        self,
        store: SessionStore,
        adapters: list[Adapter],
        *,
        host_name: str | None = None,
        display_limit: int = 3,
    ) -> None:
        self.store = store
        self.adapters = adapters
        self.host_name = host_name
        self.display_limit = display_limit

    def refresh_adapters(self) -> None:
        for adapter in self.adapters:
            try:
                sessions = adapter.poll()
            except Exception:
                log.exception("adapter %s poll failed", getattr(adapter, "name", "?"))
                continue
            # Post adapter is mutated by HTTP; still replace from poll for consistency
            self.store.replace_adapter(adapter.name, sessions)

    def snapshot(self) -> StatusSnapshot:
        self.refresh_adapters()
        return self.store.build_snapshot(
            host_name=self.host_name,
            display_limit=self.display_limit,
        )


def _client_host(request: Request) -> str:
    if request.client is None:
        return ""
    return request.client.host or ""


def require_loopback(request: Request) -> None:
    host = _client_host(request)
    # Starlette TestClient uses "testclient"; uvicorn loopback is 127.0.0.1 / ::1
    if host not in LOOPBACK and not host.startswith("127."):
        raise HTTPException(
            status_code=403,
            detail=f"loopback only (client={host!r})",
        )


def _parse_session_upsert(body: dict[str, Any]) -> list[Session]:
    if "sessions" in body:
        raw = body["sessions"]
        if not isinstance(raw, list):
            raise HTTPException(status_code=400, detail="sessions must be an array")
        try:
            return [Session.model_validate(item) for item in raw]
        except ValidationError as e:
            raise HTTPException(status_code=422, detail=e.errors()) from e
    # Single session object
    if "id" in body:
        try:
            return [Session.model_validate(body)]
        except ValidationError as e:
            raise HTTPException(status_code=422, detail=e.errors()) from e
    raise HTTPException(
        status_code=400,
        detail="body must be a Session or {sessions: [Session, ...]}",
    )


def create_app(
    store: SessionStore | None = None,
    adapters: list[Adapter] | None = None,
    *,
    host_name: str | None = None,
    display_limit: int = 3,
    enforce_loopback: bool = True,
) -> FastAPI:
    store = store or SessionStore()
    adapters = list(adapters or [])
    state = AppState(store, adapters, host_name=host_name, display_limit=display_limit)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.acd = state
        state.refresh_adapters()
        yield

    app = FastAPI(
        title="Agent Control Deck Bridge",
        version="0.1.0",
        description="Loopback hook ingress → StatusSnapshot (no deck egress in this spike).",
        lifespan=lifespan,
    )

    def guard(request: Request) -> None:
        if enforce_loopback:
            require_loopback(request)

    @app.get("/healthz")
    def healthz(request: Request) -> dict[str, bool]:
        guard(request)
        return {"ok": True}

    @app.get("/v1/status", response_model=StatusSnapshot)
    def get_status(request: Request) -> StatusSnapshot:
        guard(request)
        return state.snapshot()

    @app.post("/v1/sessions")
    def post_sessions(request: Request, body: dict[str, Any]) -> dict[str, Any]:
        guard(request)
        sessions = _parse_session_upsert(body)
        upserted = store.upsert_post(sessions)
        return {
            "ok": True,
            "upserted": len(upserted),
            "ids": [s.id for s in upserted],
        }

    @app.put("/v1/adapters/post")
    def put_post_adapter(request: Request, body: dict[str, Any]) -> dict[str, Any]:
        guard(request)
        raw = body.get("sessions", [])
        if raw is None:
            raw = []
        if not isinstance(raw, list):
            raise HTTPException(status_code=400, detail="sessions must be an array")
        try:
            sessions = [Session.model_validate(item) for item in raw]
        except ValidationError as e:
            raise HTTPException(status_code=422, detail=e.errors()) from e
        store.replace_post(sessions)
        return {"ok": True, "count": len(sessions)}

    @app.delete("/v1/sessions/{session_id:path}")
    def delete_session(session_id: str, request: Request) -> dict[str, Any]:
        guard(request)
        if not store.delete_post(session_id):
            raise HTTPException(status_code=404, detail="session not found in post set")
        return {"ok": True, "deleted": session_id}

    def _handle_vendor_hook(agent: str, payload: dict[str, Any]) -> dict[str, Any]:
        result = map_hook_event(payload, agent=agent)
        if result.action == "ignore":
            return {"ok": True, "action": "ignore"}
        if result.action == "delete":
            deleted = store.delete_post(result.session_id or "")
            return {
                "ok": True,
                "action": "delete",
                "session_id": result.session_id,
                "deleted": deleted,
            }
        assert result.session is not None
        store.upsert_post([result.session])
        return {
            "ok": True,
            "action": "upsert",
            "session": result.session.model_dump(mode="json"),
        }

    @app.post("/v1/hooks/grok")
    async def hook_grok(request: Request) -> dict[str, Any]:
        """Accept Grok Build HTTP hook envelopes (type: http)."""
        guard(request)
        try:
            payload = await request.json()
        except Exception as e:
            raise HTTPException(status_code=400, detail="invalid JSON") from e
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="JSON object required")
        return _handle_vendor_hook("grok", payload)

    @app.post("/v1/hooks/claude")
    async def hook_claude(request: Request) -> dict[str, Any]:
        """Accept Claude Code HTTP hook envelopes (type: http)."""
        guard(request)
        try:
            payload = await request.json()
        except Exception as e:
            raise HTTPException(status_code=400, detail="invalid JSON") from e
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="JSON object required")
        return _handle_vendor_hook("claude-code", payload)

    @app.exception_handler(HTTPException)
    async def http_exc_handler(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    return app


def build_adapters_from_specs(specs: list[str], store: SessionStore) -> list[Adapter]:
    """Parse CLI adapter specs: mock | file:/path | post."""
    from pathlib import Path

    from agent_control_deck_bridge.adapters.file_adapter import FileAdapter
    from agent_control_deck_bridge.adapters.mock import MockAdapter
    from agent_control_deck_bridge.adapters.post_adapter import PostAdapter

    out: list[Adapter] = []
    seen: set[str] = set()
    for spec in specs:
        if spec == "mock":
            if "mock" not in seen:
                out.append(MockAdapter())
                seen.add("mock")
        elif spec == "mock:animate":
            if "mock" not in seen:
                out.append(MockAdapter(animate=True))
                seen.add("mock")
        elif spec == "post":
            if "post" not in seen:
                out.append(PostAdapter(store))
                seen.add("post")
        elif spec.startswith("file:"):
            path = spec[len("file:") :]
            if "file" in seen:
                raise ValueError("only one file adapter supported")
            out.append(FileAdapter(Path(path)))
            seen.add("file")
        else:
            raise ValueError(f"unknown adapter spec: {spec!r}")
    # Always include post so HTTP upserts appear in snapshots when any HTTP used
    if "post" not in seen:
        out.append(PostAdapter(store))
    return out
