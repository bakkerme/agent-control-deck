# StatusSnapshot v1 — retained bridge contract

The existing session API contract remains during the desktop transition. Its models, field limits, sort order, and examples are preserved; the future desktop data model will be introduced separately.

Machine schema: [schema/status.schema.json](../schema/status.schema.json). Examples: [schema/examples/](../schema/examples/), including the historical `design_c_sessions.json` fixture containing ten sessions. Fixture filenames are retained for compatibility and do not refer to an active UI.

## Limits and ordering

- Schema version: **1**.
- Default `display_limit`: **8**; the bridge sorts before truncating.
- Sort order: error → waiting → unknown → idle → done → running, then newest `updated_at`, then ID.
- The JSON Schema allows at most 16 sessions and `sessions_total` up to 65535.
- The existing **8192-byte example budget** remains in `make schema-check`. It is a compatibility check for fixtures, not an HTTP request/response size limit.

## Snapshot fields

Required: `schema_version`, `generated_at` (ISO-8601 UTC), `host`, and `sessions`.

`host.name` has a 32-character maximum; `host.bridge_version` has a 16-character maximum. `sessions_total` reports the count before truncation. `state_counts` contains full-set tallies for running, idle, waiting, error, done, and unknown.

## Session fields

Required:

- `id`: stable session identifier, up to 64 characters.
- `agent`: provider/source label, up to 24 characters.
- `title`: short project/session label, up to 64 characters.
- `summary`: one-line status, up to 120 characters.
- `state`: `running`, `idle`, `waiting`, `error`, `done`, or `unknown`.
- `updated_at`: ISO-8601 timestamp, used for sorting.

Optional:

- `progress`: number from 0 to 1, or null.
- `detail`: secondary detail, up to 80 characters in JSON Schema, or null.
- `started_at`: ISO-8601 timestamp, or null.
- `error`: error message, up to 120 characters in JSON Schema, or null.

The existing Pydantic models are less restrictive than the JSON Schema in some places, including `detail`/`error` lengths, extra fields, and the snapshot version. This cleanup does not change those API validation semantics. Example checks run both validators.

## API and validation

`GET /v1/status` refreshes adapters and returns the merged snapshot. Sessions are in memory. Vendor hooks translate lifecycle events, while Session API and file ingress accept Session-shaped data; their body shapes are not interchangeable. See [bridge API and hooks](../bridge/README.md).

Run `make schema-check` to validate examples against the canonical JSON Schema, the bridge models, and the retained example byte budget. Keep these definitions and examples synchronized for future contract changes.
