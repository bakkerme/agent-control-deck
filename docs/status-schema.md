# StatusSnapshot v1

Canonical contract for agent status between the host bridge and the deck.  
Machine-readable schema: [`schema/status.schema.json`](../schema/status.schema.json).  
Examples: [`schema/examples/`](../schema/examples/) — including
[`design_c_sessions.json`](../schema/examples/design_c_sessions.json) (design.png content: 10 sessions, 8 on glass, `+2`).

## Wire budget

| Limit | Value |
|-------|--------|
| Max payload | **8192** bytes UTF-8 JSON (BLE reassembly buffer) |
| `schema_version` | **1** only |
| Default `display_limit` | **8** (design C · ~18–22px rows; bridge truncates before push) |
| Sort (bridge) | error → waiting → unknown → idle → done → running |

Compact JSON (`separators=(',', ':')`) on the wire. Prefer ASCII in free-text fields for FiraSans glyph safety.

## Top-level fields

| Field | Required | Notes |
|-------|----------|--------|
| `schema_version` | yes | Integer `1`. Other values → deck **SCHEMA** frame (does not increment fail_count). |
| `generated_at` | yes | ISO-8601 UTC when the bridge built the snapshot. |
| `host.name` | yes | ≤32 chars |
| `host.bridge_version` | yes | ≤16 chars |
| `sessions` | yes | Array of Session, already sorted + truncated |
| `sessions_total` | recommended | Pre-truncation count; drives top-bar `+N` |
| `state_counts` | recommended | Full-fleet tallies for top-bar icons |

## Session fields

| Field | Required | Max | Notes |
|-------|----------|-----|--------|
| `id` | yes | 64 | Stable unique id |
| `agent` | yes | 24 | e.g. `grok`, `claude-code`, `mock` |
| `title` | yes | 64 | Path / project column on glass |
| `summary` | yes | 120 | One-line free text |
| `state` | yes | — | `running` \| `idle` \| `waiting` \| `error` \| `done` \| `unknown` |
| `updated_at` | yes | — | ISO-8601; secondary sort key |
| `progress` | no | — | 0..1; retained for adapters, not drawn on design-D UI |
| `detail` | no | 80 | Optional secondary detail |
| `started_at` | no | — | ISO-8601 |
| `error` | no | 120 | Prefer when `state` is `error` |

## UI mapping (design C · 8 @ ~18–24px)

| Schema `state` | Glass label | Icon |
|----------------|-------------|------|
| `error` | failed | circle + ✕ |
| `waiting` / `unknown` | question | circle + ? |
| `done` | done | filled circle + check |
| `running` | working | open arc (spinner) |
| `idle` | idle | empty circle |

Top-bar counts: **failed** (`error`) · **question** (`waiting`+`unknown`) · **done** · **working** (`running`).  
Overflow: `+N` when `sessions_total > len(sessions)`.

## Transport notes

- **BLE:** chunked BEGIN/DATA/COMMIT over STATUS_* GATT chars; CRC32 over full body. See [`ble-spike.md`](ble-spike.md).
- **USB (planned):** one NDJSON object per line, same schema.
- Adapter HTTP (`POST /v1/sessions`, hooks) is loopback-only and is **not** the deck transport.

## Validation

Bridge: Pydantic models in `agent_control_deck_bridge.model`.  
Deck: `status_parse.cpp` (ArduinoJson) — incomplete rows are skipped; missing required top-level fields fail the snapshot.
