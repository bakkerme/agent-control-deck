# Bridge — hooks and adapters to session snapshots

Python reference implementation retained during the desktop transition. It collects agent status via files and loopback HTTP and serves StatusSnapshot v1 from an in-memory store. The sole CLI command is `acd-bridge serve`; restarting it clears posted sessions.

Design reference: [`docs/mvp-product-design.md`](../docs/mvp-product-design.md). Schema: [`docs/status-schema.md`](../docs/status-schema.md).

## Install

Requires [uv](https://docs.astral.sh/uv/) and Python ≥3.11.

```bash
cd bridge
uv sync
```

This creates `.venv/` and installs the package (editable) plus the `dev` group. Prefer `uv run …` over activating the venv.

## Run (loopback only)

```bash
# post adapter only (HTTP hooks + POST /v1/sessions)
uv run acd-bridge serve

# mock + file + post
uv run acd-bridge serve \
  --adapter mock \
  --adapter file:./examples/sessions.json

# optional host label
uv run acd-bridge serve --host-name brandon-mbp --adapter mock
```

Default bind: **`127.0.0.1:8787`**. Default **display_limit = 8** (retained v1 default). Non-loopback bind is refused unless `--allow-non-loopback`.

### Scenario adapter (transition demos)

Static `file:` / `mock` sources provide one session set. For **state transitions** (jobs appear, fail, finish, exceed the snapshot limit, and wind down), use:

```text
--adapter scenario:PATH | scenario:DIR | scenario:builtin:NAME
```

| Source | Behavior |
|--------|----------|
| `scenario:builtin:lifecycle` | Built-in desk story (empty → running → error → done → busy → quiet), loops |
| `scenario:builtin:states` | One session cycles every state (state/sort check) |
| `scenario:./examples/scenarios/lifecycle.json` | Same shape as builtin; edit freely |
| `scenario:./examples/scenarios/frames/` | Ordered `01_*.json` … full session frames |

Run a scenario through the session API:

```bash
uv run acd-bridge serve --adapter scenario:builtin:lifecycle
# Another terminal; repeat this request to advance:
curl --fail --silent http://127.0.0.1:8787/v1/status
```

Each adapter poll advances the hold counter (`hold` on the document or per step, default 1). The server polls once at startup and on every `GET /v1/status`; there is no timer. This startup poll can consume the first step before the first HTTP request.

**Scenario document shape:**

```json
{
  "name": "demo",
  "loop": true,
  "hold": 2,
  "steps": [
    { "label": "start", "sessions": [ { "id": "s1", "agent": "grok", "title": "api", "summary": "…", "state": "running", "updated_at": "…" } ] },
    { "label": "fail", "patch": [
        { "id": "s1", "state": "error", "summary": "boom", "error": "boom", "progress": null },
        { "id": "s2", "op": "upsert", "agent": "claude-code", "title": "docs", "summary": "joined", "state": "idle" },
        { "id": "s2", "op": "remove" }
      ] },
    { "label": "from file", "file": "frames/03_mixed.json" }
  ]
}
```

- **`sessions`**: replace the working set for that step.
- **`patch`**: upsert / `remove` by `id` (partial field updates; `null` clears optional fields).
- **`file`**: load a snapshot or `{ "sessions": [...] }` relative to the scenario file.
- **`hold`**: how many adapter polls keep that step active before advancing.

**Hook logging (default on):** each vendor hook logs the full JSON body (truncated at 16 KiB) plus the mapped session line:

```bash
uv run acd-bridge serve --log-level info          # default: log hooks
uv run acd-bridge serve --no-log-hooks            # quiet
```

## Ingress paths (how the pieces fit)

Two shapes of write traffic; both end up in the in-memory store and show up on `GET /v1/status`:

```text
Vendor lifecycle JSON  →  POST /v1/hooks/{grok|claude}  →  map → post adapter
Schema Session JSON    →  POST /v1/sessions (etc.)      →  post adapter
Schema Session JSON    →  file:sessions.json            →  file adapter
                                    ↓
                         GET /v1/status  (merge · sort · truncate to display_limit (default 8))
```

| Path | Role | Expected use |
|------|------|----------------|
| **Vendor hooks** (`/v1/hooks/*`) | Automatic status from Grok Build / Claude Code | Install agent hooks; no need to invent Session fields. Mapper infers state/summary from events. |
| **Session API** (`/v1/sessions`, PUT, DELETE) | Explicit Session writes | Shell jobs, CI, custom agents, scripts that know `progress`/`error`/`state`. Coexists with hook-derived sessions (different `id`s). |
| **File adapter** | Same Session schema on disk | Hooks that can’t call HTTP, or a single file rewritten by a watcher script. |
| **Read/debug** (`/healthz`, `/v1/status`) | Observe merged snapshot | Local demos, `watch`/`jq`, and tests. |

You can run **hooks only**, **Session API only**, **file only**, or any combination. Vendor hooks are a translator into the same **post** set that `POST /v1/sessions` mutates.

## HTTP API

All routes are **loopback-only** (non-loopback clients get `403`).

| Method | Path | Body | Expected use |
|--------|------|------|----------------|
| `GET` | `/healthz` | — | Process liveness / smoke check. |
| `GET` | `/v1/status` | — | Read merged `StatusSnapshot` after adapter refresh (mock + file mtime + post). Local debugging and tooling. |
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
uv run acd-bridge serve --adapter mock

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
uv run acd-bridge serve --adapter file:./examples/sessions.json
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

1. Start the bridge: `uv run acd-bridge serve`
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
ACD_SESSION_ID=post:shell:demo ./examples/hooks/post_session.sh running "Running tests"

# Or write Session JSON the file adapter understands (array or {sessions:[...]})
```

## Layout

```
bridge/
  src/agent_control_deck_bridge/
    model.py         # pydantic StatusSnapshot / Session
    store.py         # per-adapter sets + sort/truncate
    server.py        # FastAPI
    hooks.py         # Grok/Claude event → Session
    main.py          # acd-bridge serve
    scenario.py      # transition player and built-in demos
    adapters/        # mock, file, post, scenario
  examples/
    sessions.json
    hooks/           # Grok + Claude fragments + post_session.sh
    scenarios/       # lifecycle documents and frame examples
  tests/
```

## Tests

```bash
cd bridge
uv run pytest -q
```

## Transition boundaries

Existing API behavior is preserved, including SessionEnd deleting the posted session and the eight-session snapshot default. Persistent chats and user-owned names/notes will be introduced in the TypeScript desktop replacement. That future app will also add a separate Cursor adapter; the current Grok mapper is not a Cursor integration.

Agent controls, CLI-storage scraping, LAN binding by default, and cloud authentication remain out of scope. See the [desktop stages](../docs/pr-plan.md).
