# agent-control-deck

Monorepo for the Agent Control Deck — firmware and docs for a LilyGo T5 4.7" e-paper status surface (MVP: read-only agent status).

| Path | Role |
|------|------|
| [`deck/`](deck/) | PlatformIO firmware (e-paper + NimBLE push + parse spike) |
| [`docs/`](docs/) | Product / design docs + [`ble-spike.md`](docs/ble-spike.md) log |
| [`tools/ble_link/`](tools/ble_link/) | Host `bleak` soak (S1), `push_xfer` (S2), `mock_bridge` (S3/S4) |

## Hygiene

- Build artifacts (`.pio/`), secrets (`secrets.h`, `.env`), Python venvs, and OS junk are ignored via the root [`.gitignore`](.gitignore).
- Do not commit credentials or PlatformIO build output.

## Firmware

See [`deck/README.md`](deck/README.md) for build and flash instructions.
