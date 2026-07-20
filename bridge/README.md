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

**Hook logging (default on):** each vendor hook logs the full JSON body (truncated at 16 KiB) plus the mapped session line:

```bash
acd-bridge serve --log-level info          # default: log hooks
acd-bridge serve --no-log-hooks            # quiet
```

## Ingress paths (how the pieces fit)

Two shapes of write traffic; both end up in the in-memory store and show up on `GET /v1/status`:

```text
Vendor lifecycle JSON  →  POST /v1/hooks/{grok|claude}  →  map → post adapter
Schema Session JSON    →  POST /v1/sessions (etc.)      →  post adapter
Schema Session JSON    →  file:sessions.json            →  file adapter
                                    ↓
                         GET /v1/status  (merge · sort · truncate to 3)
```

| Path | Role | Expected use |
|------|------|----------------|
| **Vendor hooks** (`/v1/hooks/*`) | Automatic status from Grok Build / Claude Code | Install agent hooks; no need to invent Session fields. Mapper infers state/summary from events. |
| **Session API** (`/v1/sessions`, PUT, DELETE) | Explicit Session writes | Shell jobs, CI, custom agents, scripts that know `progress`/`error`/`state`. Coexists with hook-derived sessions (different `id`s). |
| **File adapter** | Same Session schema on disk | Hooks that can’t call HTTP, or a single file rewritten by a watcher script. |
| **Read/debug** (`/healthz`, `/v1/status`) | Observe merged snapshot | Local demos, `watch`/`jq`, tests; later the BLE push loop. Not a LAN deck-pull server. |

You can run **hooks only**, **Session API only**, **file only**, or any combination. Vendor hooks are a translator into the same **post** set that `POST /v1/sessions` mutates.

## HTTP API

All routes are **loopback-only** (non-loopback clients get `403`).

| Method | Path | Body | Expected use |
|--------|------|------|----------------|
| `GET` | `/healthz` | — | Process liveness / smoke check. |
| `GET` | `/v1/status` | — | Read merged `StatusSnapshot` after adapter refresh (mock + file mtime + post). Debug, tooling, future deck push source. |
| `POST` | `/v1/sessions` | One **Session** object, **or** `{ "sessions": [ Session, … ] }` | **Upsert by `id`** into the post set. Other post ids unchanged. Prefer for long-running jobs, shell helpers (`examples/hooks/post_session.sh`), multi-source posts. Required Session fields: `id`, `agent`, `title`, `summary`, `state`, `updated_at`. |
| `PUT` | `/v1/adapters/post` | `{ "sessions": [ … ] }` (empty/missing → clear) | **Replace entire post set** in one shot. Use when a single controller owns all post sessions and rewrites state each tick. Avoid for “update one job” (use POST upsert). |
| `DELETE` | `/v1/sessions/{id}` | — | Remove one id from the **post** set only (does not touch mock/file). Manual cleanup, job end without SessionEnd, or fix a stuck hook session. |
| `POST` | `/v1/hooks/grok` | Vendor lifecycle JSON (any object) | Grok Build command-hook forwarder. Shared mapper with Claude; result `agent=grok`, ids like `post:grok:{sessionId}`. |
| `POST` | `/v1/hooks/claude` | Vendor lifecycle JSON (any object) | Claude Code HTTP or command hooks. Same mapper; `agent=claude-code`. Field names normalized (`sessionId` / `session_id`, etc.). |

**Not interchangeable:**

- `/v1/hooks/*` expects a **lifecycle envelope** (events). Do not send a Session object there unless it also looks like an event (it will map poorly).
- `/v1/sessions` expects a **Session**. Do not POST raw Grok/Claude hook JSON there (validation will fail or fields won’t match).

### Session body example (`POST /v1/sessions`)

```json
{
  "id": "post:job-1",
  "agent": "other",
  "title": "spike",
  "summary": "Wire agent hooks",
  "state": "running",
  "progress": 0.4,
  "detail": "optional secondary line",
  "updated_at": "2026-07-20T18:00:00Z",
  "error": null
}
```

`state`: `running` | `idle` | `waiting` | `error` | `done` | `unknown`.

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

Lifecycle events are mapped into the **post** adapter:

| Event | Bridge action |
|-------|----------------|
| `SessionStart` | Upsert session `running` |
| `UserPromptSubmit` | Upsert; summary ← prompt text |
| `PostToolUse` / `PreToolUse` | Upsert; summary/detail ← tool |
| `Stop` | Upsert `idle` (uses `last_assistant_message` when present) |
| `StopFailure` / tool failure | Upsert `error` |
| `SessionEnd` | **Delete** session from post set |

### Grok Build — use `type: "command"`, not `type: "http"`

Grok **only allows `https://` URLs** for `type: "http"` hooks. The MVP bridge is **loopback plain HTTP** (`http://127.0.0.1:8787`), so native HTTP hooks cannot target it.

The example uses **command hooks** that pipe the event JSON (stdin) through `curl` to the bridge:

```bash
curl … -X POST http://127.0.0.1:8787/v1/hooks/grok … --data-binary @-
```

1. Start the bridge: `acd-bridge serve`
2. Install example hooks (global):

```bash
mkdir -p ~/.grok/hooks
cp examples/hooks/grok-acd-status.json ~/.grok/hooks/
# optional helper (same curl, reusable for Claude):
# cp examples/hooks/forward_acd_hook.sh ~/.grok/hooks/ && chmod +x ~/.grok/hooks/forward_acd_hook.sh
```

3. Restart Grok (or reload hooks with `r` in the Hooks tab / `/hooks`).
4. Watch status:

```bash
watch -n 2 'curl -s http://127.0.0.1:8787/v1/status | jq .sessions'
```

Do **not** point Grok `type: "http"` at `http://127.0.0.1:…` — it will be rejected. A future option is TLS on the bridge (self-signed + trust store), but command+curl is enough for this spike.

### Claude Code

Claude’s HTTP hooks allow `http://` (including localhost). Merge
`examples/hooks/claude-settings.fragment.json` → `hooks` into:

- `~/.claude/settings.json` (user-wide), or
- `.claude/settings.json` (project)

Then restart Claude Code. Events POST to `http://127.0.0.1:8787/v1/hooks/claude`.

If you prefer the same fail-open shell path as Grok, use
`examples/hooks/forward_acd_hook.sh claude` as a `type: "command"` hook instead.

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
