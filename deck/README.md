# deck

PlatformIO firmware for the **LilyGo T5-ePaper** (classic **ESP32-WROVER**, 4.7" 960×540 e-paper).

## Current status

**BLE spike S1–S4:** NimBLE **peripheral** advertises `ACD-****`, accepts one central, reassembles chunked StatusSnapshot writes (≤ 8 KiB + CRC32), parses JSON → `DeckView`, redraws e-paper, and marks **STALE** after ~30 s without a successful push. Wi‑Fi is forced **off**.

| Module | Role |
|--------|------|
| `src/display.*` | E-paper init, PSRAM framebuffer, power/present |
| `src/status_model.h` | C structs for `DeckView` / session rows |
| `src/status_parse.*` | ArduinoJson StatusSnapshot → `DeckView` (S3) |
| `src/ui_layout.*` | Draw header / rows / footer into the framebuffer |
| `src/ble_gatt.*` | NimBLE advertise/connect/HEARTBEAT + CTRL/DATA/STATE (S1–S2) |
| `src/main.cpp` | Wi‑Fi off → BLE poll → parse → present; STALE grace (S4) |

ASCII state tokens: `*` running, `o` idle, `...` waiting, `!` error, `v` done, `?` unknown.

## Prerequisites

- [PlatformIO Core](https://docs.platformio.org/en/latest/core/installation.html) (`pio`)
- This board: **ESP32**, not ESP32-S3
- A local checkout of [LilyGo-EPD47](https://github.com/Xinyuan-LilyGO/LilyGo-EPD47) as a sibling of this monorepo:

  ```text
  sources/
    LilyGo-EPD47/          # display driver library
    agent-control-deck/
      deck/                # this project
  ```

  `platformio.ini` depends on it via `file://../../LilyGo-EPD47`. Adjust that path if your layout differs.

## Commands

```bash
cd deck

pio run                 # build
pio run -t upload       # flash
pio device monitor      # serial @ 115200

pio run -t upload && pio device monitor
```

Host tools (after flash):

```bash
cd ../tools/ble_link
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# S1 link soak
python connect_soak.py --duration 1800

# S2 bulk transfer (100 consecutive)
python push_xfer.py --count 100

# S3/S4 mock bridge — 3 sessions on glass; kill process → STALE ~30s
python mock_bridge.py --animate
```

Wire format and acceptance logs: [`docs/ble-spike.md`](../docs/ble-spike.md).

If the port is busy, close other serial monitors. If upload still fails, hold **BOOT**, tap **RST**, release **BOOT**, then upload again.

## Board notes

| Item | Value |
|------|--------|
| Env | `T5-ePaper` |
| Chip | ESP32 (+ PSRAM) |
| Panel | 960×540, 4-bit grayscale |
| Upload | ~460800 baud, external USB-UART |
| BLE name | `ACD-` + last 4 hex of BT MAC |
| STALE grace | 30 s without successful v1 commit |

Do **not** use the `T5-ePaper-S3` target unless you have the S3 hardware.
