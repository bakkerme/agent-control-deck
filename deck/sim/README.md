# deck/sim — PC UI simulation (pixel-accurate)

Host binary that compiles the **same** firmware layout sources (`ui_layout.cpp`, `status_parse.cpp`, `firasans_ui.h`) against a software e-paper framebuffer and shows the result in an SDL2 window.

This is **not** a second HTML mock: glyph metrics, truncation, icons, and frame priority match the glass code path.

## Prerequisites (macOS)

```bash
brew install cmake sdl2
# curl is used only for --from-url (usually preinstalled)
```

First configure downloads ArduinoJson v7 via CMake `FetchContent` (network once).

## Build

```bash
cd deck/sim
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

Binary: `deck/sim/build/acd-ui-sim`

## Run

```bash
# Design.png fleet (8 rows + top-bar +2)
./build/acd-ui-sim ../../schema/examples/design_c_sessions.json

# Mock 3 sessions, 2× pixels
./build/acd-ui-sim --scale 2 ../../schema/examples/mock_3sessions.json

# Device frames (JSON does not carry link/STALE — flags set DeckView)
./build/acd-ui-sim --stale --age-ms 45000 ../../schema/examples/mock_3sessions.json
./build/acd-ui-sim --no-link --age-ms 60000 ../../schema/examples/mock_3sessions.json
./build/acd-ui-sim --schema ../../schema/examples/mock_3sessions.json
./build/acd-ui-sim --empty ../../schema/examples/mock_3sessions.json

# Headless screenshot
./build/acd-ui-sim --bmp /tmp/deck.bmp ../../schema/examples/design_c_sessions.json

# Live bridge (separate terminal: acd-bridge serve --adapter mock)
./build/acd-ui-sim --from-url http://127.0.0.1:8787/v1/status --poll 2
```

### Window keys

| Key | Action |
|-----|--------|
| `q` / Esc | Quit |
| `r` | Reload source |
| `s` | Toggle STALE |
| `n` | NO LINK (stale + empty) |
| `e` | Toggle SCHEMA fault |
| `0` | Healthy (clear overlays) |

## Accuracy notes

| Matches firmware | Does not match |
|------------------|----------------|
| FiraSansUI metrics / ellipsis cut | Physical e-paper flash / ghosting |
| Icon geometry (circle/line pixels) | Optical contrast of paper |
| Frame priority SCHEMA → NO LINK → normal | BLE timings / fail_count policy |

Software draw helpers and font rasterizer are adapted from [LilyGo-EPD47](https://github.com/Xinyuan-LilyGO/LilyGo-EPD47) (GPL-3.0). The sim binary therefore inherits GPL-3.0 obligations if distributed.

## Layout

| Path | Role |
|------|------|
| `include/epd_driver.h` | Host software-only EPD API |
| `host_epd_draw.c` | pixel/line/circle/rect into 4-bit FB |
| `host_font.c` | `writeln` / `get_text_bounds` |
| `main.cpp` | CLI, parse, SDL present |
| `../src/ui_layout.cpp` | Shared with firmware |
| `../src/status_parse.cpp` | Shared with firmware |
