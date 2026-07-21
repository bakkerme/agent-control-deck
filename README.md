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

## MVP quickstart (~10 minutes)

**Prerequisites:** deck USB-plugged, PlatformIO installed, sibling [LilyGo-EPD47](https://github.com/Xinyuan-LilyGO/LilyGo-EPD47) checkout, macOS Bluetooth allowed for Terminal/IDE.

### 1. Flash the deck

```bash
cd deck
pio run -t upload
pio device monitor   # note name: ACD-**** ; Ctrl-C when ready
```

### 2. Install and run the bridge (hooks + store)

```bash
cd bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Loopback HTTP for hooks / Session API (keep running)
acd-bridge serve --adapter mock --adapter post
```

Default: `http://127.0.0.1:8787`. Vendor hooks: see [`bridge/README.md`](bridge/README.md).

### 3. Push status to the glass

In a **second** terminal (same venv):

```bash
cd bridge && source .venv/bin/activate

# Poll the running server and push every 15s
acd-bridge push-ble

# Or one-shot
acd-bridge push-ble --once

# Or local mock without HTTP
acd-bridge push-ble --adapter mock --once
```

You should see mock (and any hook) sessions on the e-paper: top-bar state counts, up to **7** rows (icon · path · summary). Kill `push-ble` → deck shows **STALE** after ~30 s.

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

- Build artifacts (`.pio/`), secrets, Python venvs, and OS junk are ignored via [`.gitignore`](.gitignore).
- Do not commit credentials or PlatformIO build output.
