# deck

PlatformIO firmware for the **LilyGo T5-ePaper** (classic **ESP32-WROVER**, 4.7" 960×540 e-paper).

## Current status

Firmware draws a **hardcoded multi-session status layout** from a compile-time `DeckView` fixture (header, up to 3 session rows with ASCII state tokens and geometric progress bars, footer). There is **no radio, no WiFi, no BLE, and no JSON parse** yet — this is a visual demo of the on-glass layout only.

| Module | Role |
|--------|------|
| `src/display.*` | E-paper init, PSRAM framebuffer, power/present |
| `src/status_model.h` | C structs for `DeckView` / session rows (no parse) |
| `src/ui_layout.*` | Draw header / rows / footer into the framebuffer |
| `src/main.cpp` | Build demo fixture → `ui_draw_status` → present |

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

If the port is busy, close other serial monitors. If upload still fails, hold **BOOT**, tap **RST**, release **BOOT**, then upload again.

## Board notes

| Item | Value |
|------|--------|
| Env | `T5-ePaper` |
| Chip | ESP32 (+ PSRAM) |
| Panel | 960×540, 4-bit grayscale |
| Upload | ~460800 baud, external USB-UART |

Do **not** use the `T5-ePaper-S3` target unless you have the S3 hardware.
