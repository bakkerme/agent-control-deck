# deck

PlatformIO firmware for the **LilyGo T5-ePaper** (classic **ESP32-WROVER**, 4.7" 960×540 e-paper).

## Current status

**MVP BLE path:** NimBLE **peripheral** advertises `ACD-****`, accepts one central, reassembles chunked StatusSnapshot writes (≤ 8 KiB + CRC32), parses JSON → `DeckView`, redraws e-paper (**design C · up to 8 rows @ ~18–22px**), and marks **STALE** after ~30 s without a successful push. Wi‑Fi is forced **off**.

| Module | Role |
|--------|------|
| `src/display.*` | E-paper init, PSRAM framebuffer, power/present |
| `src/status_model.h` | C structs for `DeckView` / session rows |
| `src/status_parse.*` | ArduinoJson StatusSnapshot → `DeckView` |
| `src/ui_layout.*` | Top bar (counts + link) + icon/path/summary rows |
| `src/ble_gatt.*` | NimBLE advertise/connect + CTRL/DATA/STATE |
| `src/main.cpp` | Wi‑Fi off → BLE poll → parse → present; STALE grace |

UI reference: [`designs/epaper-status-board.html`](../designs/epaper-status-board.html) (variant **D · 7 @ 20px**).

## PC UI simulation

Pixel-accurate host preview of this firmware’s layout (no BLE / no panel):

```bash
cd sim
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build
./build/acd-ui-sim ../../schema/examples/design_c_sessions.json
```

Requires `cmake` + `sdl2` (`brew install cmake sdl2`). See [`sim/README.md`](sim/README.md).

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

Host push (after flash):

```bash
cd ../bridge
source .venv/bin/activate
acd-bridge push-ble --once          # needs acd-bridge serve on :8787
# or
acd-bridge push-ble --adapter mock --once

# Design.png fixture (8 rows on glass + top-bar +2):
acd-bridge push-ble --adapter file:../schema/examples/design_c_sessions.json --once
# or low-level:
#   cd ../tools/ble_link && python push_xfer.py --payload payloads/design_c_sessions.json
```

Low-level soak tools remain under [`tools/ble_link/`](../tools/ble_link/). Wire format: [`docs/ble-spike.md`](../docs/ble-spike.md).

If the port is busy, close other serial monitors. If upload still fails, hold **BOOT**, tap **RST**, release **BOOT**, then upload again.

## Board notes

| Item | Value |
|------|--------|
| Env | `T5-ePaper` |
| Chip | ESP32 (+ PSRAM) |
| Panel | 960×540, 4-bit grayscale |
| Layout | design C: 8 rows (FiraSansUI ~18px + 30px icons), no footer / no progress bars |
| Upload | ~460800 baud, external USB-UART |
| BLE name | `ACD-` + last 4 hex of BT MAC |
| STALE grace | 30 s without successful v1 commit |

Do **not** use the `T5-ePaper-S3` target unless you have the S3 hardware.
