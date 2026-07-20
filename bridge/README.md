# Bridge — hook ingress spike

Python host process that collects agent status via **file** and **loopback HTTP**, and builds a versioned `StatusSnapshot`.

**This spike does not push to the deck.** BLE/USB egress stays in `tools/ble_link/` until the production bridge wires them together.

Design reference: [`docs/mvp-product-design.md`](../docs/mvp-product-design.md) (host bridge architecture, adapter merge, loopback POST).

## Install

```bash
cd bridge
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Run (loopback only)

```bash
# post adapter only (HTTP hooks + POST /v1/sessions)
acd-bridge serve

# mock + file + post
acd-bridge serve \
  --adapter mock \
  --adapter file:./examples/sessions.json

# optional host footer label
acd-bridge serve --host-name brandon-mbp --adapter mock
```

Default bind: **`127.0.0.1:8787`**. Non-loopback bind is refused unless `--allow-non-loopback` (still not recommended for hooks).

### HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/healthz` | Liveness |
| `GET` | `/v1/status` | Full `StatusSnapshot` (debug / future tools) |
| `POST` | `/v1/sessions` | Upsert one Session or `{sessions:[...]}` into **post** set |
| `PUT` | `/v1/adapters/post` | Replace entire **post** set |
| `DELETE` | `/v1/sessions/{id}` | Remove one id from **post** set only |
| `POST` | `/v1/hooks/grok` | Grok Build HTTP hook envelope → session upsert/delete |
| `POST` | `/v1/hooks/claude` | Claude Code HTTP hook envelope → session upsert/delete |

All routes reject non-loopback clients (`403`).

### Quick curl demo

```bash
# Terminal A
acd-bridge serve --adapter mock

# Terminal B
curl -s http://127.0.0.1:8787/v1/status | jq .

curl -s -X POST http://127.0.0.1:8787/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "post:job-1",
    "agent": "other",
    "title": "spike",
    "summary": "Wire agent hooks",
    "state": "running",
    "updated_at": "2026-07-20T18:00:00Z"
  }' | jq .

curl -s http://127.0.0.1:8787/v1/status | jq '.sessions'
```

File adapter example:

```bash
acd-bridge serve --adapter file:./examples/sessions.json
# edit examples/sessions.json → next GET /v1/status reloads on mtime change
```

## Agent hooks (Grok Build + Claude Code)

Both agents can POST lifecycle events as **HTTP hooks**. The bridge maps events into the **post** adapter:

| Event | Bridge action |
|-------|----------------|
| `SessionStart` | Upsert session `running` |
| `UserPromptSubmit` | Upsert; summary ← prompt text |
| `PostToolUse` / `PreToolUse` | Upsert; summary/detail ← tool |
| `Stop` | Upsert `idle` (uses `last_assistant_message` when present) |
| `StopFailure` / tool failure | Upsert `error` |
| `SessionEnd` | **Delete** session from post set |

### Grok Build

1. Start the bridge: `acd-bridge serve`
2. Install example hooks (global):

```bash
mkdir -p ~/.grok/hooks
cp examples/hooks/grok-acd-status.json ~/.grok/hooks/
```

3. Restart Grok (or reload hooks with `r` in the Hooks tab / `/hooks`).
4. Watch status:

```bash
watch -n 2 'curl -s http://127.0.0.1:8787/v1/status | jq .sessions'
```

### Claude Code

Merge `examples/hooks/claude-settings.fragment.json` → `hooks` into:

- `~/.claude/settings.json` (user-wide), or
- `.claude/settings.json` (project)

Then restart Claude Code. Events POST to `http://127.0.0.1:8787/v1/hooks/claude`.

### Generic shell / file hooks

```bash
# POST helper
chmod +x examples/hooks/post_session.sh
ACD_SESSION_ID=post:shell:demo ./examples/hooks/post_session.sh running "Building firmware"

# Or write Session JSON the file adapter understands (array or {sessions:[...]})
```

## Layout

```
bridge/
  src/agent_control_deck_bridge/
    model.py       # pydantic StatusSnapshot / Session
    store.py       # per-adapter sets + sort/truncate
    server.py      # FastAPI
    hooks.py       # Grok/Claude event → Session
    main.py        # acd-bridge CLI
    adapters/      # mock, file, post
  examples/
    sessions.json
    hooks/         # Grok + Claude fragments + post_session.sh
  tests/
```

## Tests

```bash
cd bridge
source .venv/bin/activate
pytest -q
```

## Out of scope (this spike)

- BLE / USB / Option B push to the deck
- Named scrapers that reverse-engineer agent CLIs
- Binding `0.0.0.0` as a product default
- Auth beyond loopback

Next step toward product: compose this store with `tools/ble_link` push (or production `ble_out.py`) on an interval.
