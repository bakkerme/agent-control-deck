# agent-control-deck

Monorepo for the **Agent Control Deck** — a LilyGo T5 4.7" e-paper **read-only** status surface for AI coding agents.

Control features (kill, approve, inject) are **out of scope** for this MVP.

| Path | Role |
|------|------|
| [`deck/`](deck/) | PlatformIO firmware (e-paper + NimBLE peripheral + design-D layout) |
| [`bridge/`](bridge/) | Host bridge: file/POST/hooks → StatusSnapshot → **BLE push** |
| [`schema/`](schema/) | StatusSnapshot v1 JSON Schema + examples |
| [`docs/`](docs/) | Product design, schema notes, BLE spike log |
| [`tools/ble_link/`](tools/ble_link/) | Low-level BLE soak / transfer tools (spike path) |
| [`designs/`](designs/) | UI reference (HTML wireframes) |
| [`deck/sim/`](deck/sim/) | Host UI sim — same layout C++ + SDL2 preview (no glass) |

## Make targets

Common workflows are wired in the root [`Makefile`](Makefile). Run `make` / `make help` for the full list.

```bash
make bridge-install          # uv sync (editable + dev)
make bridge-serve            # loopback HTTP (mock + post)
make bridge-test             # pytest
make sim-build && make sim   # SDL UI preview (EXAMPLE=… SCALE=2)
make deck-build              # PlatformIO firmware
make deck-flash              # upload + serial monitor
make push-ble-once           # one-shot BLE push (serve must be up)
make push-ble-mock           # push local mock, no HTTP
make schema-check            # validate schema/examples
make check                   # tests + schema + firmware & sim builds
```

Overrides: `ADAPTERS="mock post"`, `EXAMPLE=mock_3sessions.json`, `ONCE=1`, `NAME=ACD-A1B2`, `BMP=/tmp/deck.bmp`, `SIM_FLAGS=--stale`, etc.

## PC UI simulation (no hardware)

Preview the **same** e-paper layout code the firmware uses (FiraSansUI metrics, truncation, icons) on your Mac/PC:

```bash
brew install cmake sdl2   # once

cd deck/sim
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build

./build/acd-ui-sim ../../schema/examples/design_c_sessions.json
# STALE / NO LINK / SCHEMA:
./build/acd-ui-sim --stale --age-ms 45000 ../../schema/examples/mock_3sessions.json
./build/acd-ui-sim --bmp /tmp/deck.bmp ../../schema/examples/design_c_sessions.json
```

Live with the bridge mock:

```bash
# terminal 1
cd bridge && uv run acd-bridge serve --adapter mock

# terminal 2
deck/sim/build/acd-ui-sim --from-url http://127.0.0.1:8787/v1/status --poll 2
```

Details: [`deck/sim/README.md`](deck/sim/README.md).

## MVP quickstart (~10 minutes)

**Prerequisites:** deck USB-plugged, PlatformIO installed, sibling [LilyGo-EPD47](https://github.com/Xinyuan-LilyGO/LilyGo-EPD47) checkout, macOS Bluetooth allowed for Terminal/IDE.

### 1. Flash the deck

```bash
cd deck
pio run -t upload
pio device monitor   # note name: ACD-**** ; Ctrl-C when ready
```

### 2. Install and run the bridge (hooks + store)

Requires [uv](https://docs.astral.sh/uv/) and Python ≥3.11.

```bash
cd bridge
uv sync

# Loopback HTTP for hooks / Session API (keep running)
uv run acd-bridge serve --adapter mock --adapter post
```

Default: `http://127.0.0.1:8787`. Vendor hooks: see [`bridge/README.md`](bridge/README.md).

### 3. Push status to the glass

In a **second** terminal (from `bridge/`):

```bash
cd bridge

# Poll the running server and push every 15s
uv run acd-bridge push-ble

# Or one-shot
uv run acd-bridge push-ble --once

# Or local mock without HTTP
uv run acd-bridge push-ble --adapter mock --once

# Multi-step transitions (empty → running → error → done → overflow → quiet)
uv run acd-bridge push-ble --adapter scenario:builtin:lifecycle --interval 3
# make push-ble-scenario INTERVAL=3
```

You should see mock (and any hook) sessions on the e-paper: top-bar state counts, up to **7** rows (icon · path · summary). Kill `push-ble` → deck shows **STALE** after ~30 s. With `scenario:…`, the glass should redraw as sessions appear, change state, and leave.

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `no ACD-* device found` | Deck powered/flashed? macOS Bluetooth permission? Closer range. |
| Deck stays blank / NO LINK | Serial monitor for `[ble]` / `[status]` lines; run `push-ble --once` and watch `state='ok'`. |
| SCHEMA frame | Bridge and firmware schema_version must be `1`. |
| Hook server busy / wrong sessions | `curl -s http://127.0.0.1:8787/v1/status \| jq`. |
| Upload fails | Hold **BOOT**, tap **RST**, release **BOOT**, retry. |

Schema details: [`docs/status-schema.md`](docs/status-schema.md). Product design: [`docs/mvp-product-design.md`](docs/mvp-product-design.md).

## Hygiene

- Build artifacts (`.pio/`), secrets, local envs (`.venv/`), and OS junk are ignored via [`.gitignore`](.gitignore). Commit `bridge/uv.lock` for reproducible bridge installs.
- Do not commit credentials or PlatformIO build output.
