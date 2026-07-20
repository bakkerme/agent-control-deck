# deck

PlatformIO firmware for the **LilyGo T5-ePaper** (classic **ESP32-WROVER**, 4.7" 960×540 e-paper).

## Current status

**PR-S1 spike:** NimBLE **peripheral** advertises `ACD-****`, accepts one central, notifies a heartbeat, and logs heap/MTU on Serial. Wi‑Fi is forced **off**. The e-paper still shows the PR1b **hardcoded multi-session layout** once at boot (not driven by BLE yet — that is S3).

| Module | Role |
|--------|------|
| `src/display.*` | E-paper init, PSRAM framebuffer, power/present |
| `src/status_model.h` | C structs for `DeckView` / session rows (no parse) |
| `src/ui_layout.*` | Draw header / rows / footer into the framebuffer |
| `src/ble_gatt.*` | NimBLE advertise / connect / HEARTBEAT notify + INFO |
| `src/main.cpp` | Wi‑Fi off → draw demo → BLE link loop |

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

Host link soak (after flash):

```bash
cd ../tools/ble_link
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python connect_soak.py --duration 1800
```

See [`docs/ble-spike.md`](../docs/ble-spike.md) for UUIDs and acceptance log template.

If the port is busy, close other serial monitors. If upload still fails, hold **BOOT**, tap **RST**, release **BOOT**, then upload again.

## Board notes

| Item | Value |
|------|--------|
| Env | `T5-ePaper` |
| Chip | ESP32 (+ PSRAM) |
| Panel | 960×540, 4-bit grayscale |
| Upload | ~460800 baud, external USB-UART |
| BLE name | `ACD-` + last 4 hex of BT MAC |

Do **not** use the `T5-ePaper-S3` target unless you have the S3 hardware.
