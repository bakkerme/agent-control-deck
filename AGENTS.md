# AGENTS.md — Agent Control Deck

Guidance for AI coding agents working in this monorepo.

## What this is

**Agent Control Deck** is a **read-only** LilyGo T5 4.7" e-paper status surface for AI coding agents. The host bridge collects agent session state and **pushes** a `StatusSnapshot` to the deck over BLE.

**Out of scope for MVP (do not implement unless explicitly asked):**

- Agent control (kill, approve, inject prompt, any intervention)
- SoftAP on the deck
- Host TCP listen as the product transport for the deck (firewalled hosts)
- Option B LAN reverse-push
- Named scrapers that reverse-engineer agent CLIs
- Cloud / multi-tenant auth
- Binding the bridge on non-loopback by default

Product source of truth: [`docs/mvp-product-design.md`](docs/mvp-product-design.md). Tickets: [`docs/pr-plan.md`](docs/pr-plan.md).

## Monorepo layout

| Path | Role | Stack |
|------|------|--------|
| [`deck/`](deck/) | Firmware: e-paper UI + NimBLE peripheral | PlatformIO, Arduino/ESP32, C++ |
| [`deck/sim/`](deck/sim/) | Host UI sim (same layout sources + SDL2) | CMake, SDL2 |
| [`bridge/`](bridge/) | Host: hooks/file/POST → store → BLE push | Python ≥3.11, FastAPI, Pydantic, bleak |
| [`schema/`](schema/) | StatusSnapshot v1 JSON Schema + examples | JSON Schema |
| [`tools/ble_link/`](tools/ble_link/) | Low-level BLE soak / transfer (spike tools) | Python + bleak |
| [`docs/`](docs/) | Design, schema notes, BLE spike log, PR plan | Markdown |
| [`designs/`](designs/) | UI wireframes / reference images | HTML, PNG |

## Architecture (locked)

```text
Agent hooks / Session API / file  →  bridge store  →  StatusSnapshot v1
                                                         │
                                              acd-bridge push-ble (central)
                                                         │
                                              BLE chunked GATT write
                                                         │
                                              deck NimBLE peripheral (ACD-****)
                                                         │
                                              parse → DeckView → e-paper redraw
```

- **Primary portable transport:** BLE host-push. Deck advertises `ACD-*`; host is central.
- **Bridge HTTP** (`127.0.0.1:8787`) is for **hooks, adapters, and debug only** — not deck transport.
- **USB NDJSON** exclusive mode is planned (desk/debug); not concurrent with radio modes yet.
- **Wi‑Fi is forced off** on the deck in the current BLE path.

## Shared contract: StatusSnapshot v1

Canonical docs: [`docs/status-schema.md`](docs/status-schema.md), machine schema: [`schema/status.schema.json`](schema/status.schema.json).

| Constraint | Value |
|------------|--------|
| `schema_version` | **1** only (other → deck SCHEMA frame) |
| Max payload | **8192** bytes UTF-8 JSON (BLE reassembly) |
| Default `display_limit` | **8** (design C) |
| Sort order (bridge) | error → waiting → unknown → idle → done → running |
| Wire JSON | Compact (`separators=(',', ':')`); prefer ASCII free-text for FiraSans |

**Keep these in sync when changing the contract:**

1. `schema/status.schema.json` + examples under `schema/examples/`
2. Bridge Pydantic models: `bridge/src/agent_control_deck_bridge/model.py`
3. Deck parse/view: `deck/src/status_parse.*`, `deck/src/status_model.h`
4. `docs/status-schema.md`

Session `state` enum: `running` | `idle` | `waiting` | `error` | `done` | `unknown`.

## Deck firmware (`deck/`)

- Board: **LilyGo T5-ePaper classic ESP32-WROVER** (960×540, 4-bit grayscale). **Not** ESP32-S3 (`T5-ePaper-S3`) unless the user has that hardware.
- Depends on sibling checkout: `sources/LilyGo-EPD47` via `file://../../LilyGo-EPD47` in `platformio.ini`.
- Layout: **design C · up to 8 rows** (FiraSansUI ~18px, 30px icons). No footer / no progress bars on glass (progress field may still exist in schema for adapters).
- STALE grace: ~**30 s** without a successful push.
- Shared UI sources with the sim: `ui_layout.cpp`, `status_parse.cpp`, `firasans_ui.h` — prefer editing those once for both firmware and sim.

```bash
cd deck
pio run                 # build
pio run -t upload       # flash
pio device monitor      # 115200
```

Upload stuck: hold **BOOT**, tap **RST**, release **BOOT**, retry.

## Host UI sim (`deck/sim/`)

Use this to validate layout/truncation/icons **without hardware**. Matches firmware metrics; does not match e-paper flash/ghosting or BLE timings.

```bash
brew install cmake sdl2   # once (macOS)
cd deck/sim
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build
./build/acd-ui-sim ../../schema/examples/design_c_sessions.json
./build/acd-ui-sim --bmp /tmp/deck.bmp ../../schema/examples/design_c_sessions.json
# Live against bridge:
./build/acd-ui-sim --from-url http://127.0.0.1:8787/v1/status --poll 2
```

Do not commit `deck/sim/build/`.

## Bridge (`bridge/`)

Package: `agent_control_deck_bridge`. CLI: `acd-bridge`. Requires [uv](https://docs.astral.sh/uv/).

| Command | Role |
|---------|------|
| `acd-bridge serve` | Loopback HTTP (hooks, Session API, `GET /v1/status`) |
| `acd-bridge push-ble` | BLE central push loop (poll → chunked write) |

```bash
cd bridge
uv sync                 # creates .venv from uv.lock; includes dev group
uv run pytest -q

uv run acd-bridge serve --adapter mock --adapter post
# other terminal:
uv run acd-bridge push-ble --once
```

Commit `bridge/uv.lock`. Prefer `uv run …` over activating `.venv` by hand.

Default bind: **`127.0.0.1:8787`**. Non-loopback is refused unless `--allow-non-loopback`.

### Ingress rules (do not mix body shapes)

| Path | Body |
|------|------|
| `POST /v1/hooks/grok` or `/claude` | Vendor **lifecycle** event JSON → mapped Session |
| `POST /v1/sessions` | Schema **Session** (or `{ "sessions": [...] }`) upsert by `id` |
| `PUT /v1/adapters/post` | Replace entire post set |
| File adapter | Session array / `{sessions:[...]}` on disk |

Grok Build **cannot** use `type: "http"` against plain `http://127.0.0.1` (HTTPS only). Use **command** hooks + curl; see `bridge/examples/hooks/`.

Module map:

- `model.py` — Pydantic StatusSnapshot / Session
- `store.py` — merge, sort, truncate
- `server.py` — FastAPI
- `hooks.py` — Grok/Claude → Session
- `ble_protocol.py` / `ble_device.py` / `ble_out.py` — BLE egress
- `adapters/` — mock, file, post

## BLE protocol notes

Spike history and wire details: [`docs/ble-spike.md`](docs/ble-spike.md). Production path lives in the bridge (`ble_*`); low-level tools remain under `tools/ble_link/` for soak/debug.

- Chunked BEGIN / DATA / COMMIT; CRC32 over full body
- Device name: `ACD-` + last 4 hex of BT MAC
- Prefer fixing protocol bugs in bridge + firmware together; keep `tools/ble_link` as a thin debug path if you touch framing

## Working agreements

1. **Read-only MVP** — do not add control surface APIs, kill buttons, or intervention protocol without an explicit product ask.
2. **Contract first** — schema changes need bridge + deck parse + docs/examples in the same change set (or clearly staged PRs that keep the tree buildable).
3. **Prefer the sim** for UI work; flash when validating BLE, STALE, or panel-specific behavior.
4. **Loopback trust model** — no product default auth; do not open the bridge to the LAN as a “fix.”
5. **Keep builds clean** — do not commit `.pio/`, `deck/sim/build/`, `.venv/`, secrets, `.env`, or credentials.
6. **Classic ESP32 constraints** — RAM/NimBLE config is tight (`CONFIG_BT_NIMBLE_MAX_CONNECTIONS=1`, central/observer roles disabled). Avoid casual BLE role or Wi‑Fi coexistence experiments without a design note.
7. **E-paper discipline** — change-driven redraws; panel power only during present; no high-frequency full refresh.

## Verify before finishing

| Change area | Minimum check |
|-------------|----------------|
| Bridge logic / hooks / store | `cd bridge && source .venv/bin/activate && pytest -q` |
| Schema / examples | Validate against `schema/status.schema.json`; keep examples under 8 KiB |
| Layout / UI strings | `deck/sim` build + screenshot or interactive preview |
| Firmware compile | `cd deck && pio run` (needs PlatformIO + LilyGo-EPD47 sibling) |
| End-to-end BLE | Flash deck + `acd-bridge push-ble --once` (hardware + macOS BT permission) |

## Doc map

| Need | Open |
|------|------|
| Product goals / non-goals / architecture | `docs/mvp-product-design.md` |
| Field dictionary & UI mapping | `docs/status-schema.md` |
| BLE spike evidence / framing | `docs/ble-spike.md` |
| Ticket status / sequencing | `docs/pr-plan.md` |
| Root quickstart | `README.md` |
| Bridge API & hooks | `bridge/README.md` |
| Firmware flash & board notes | `deck/README.md` |
| Sim flags & accuracy | `deck/sim/README.md` |
