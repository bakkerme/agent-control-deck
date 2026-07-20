# BLE transport spike log

Tracks S1–S4 results against the [MVP product design](mvp-product-design.md#ble-transport-spike) decision matrix.

**Roles:** deck = GATT peripheral (NimBLE); host = `bleak` central. **Wi‑Fi off** on deck for the spike.

## Fixed identities (implementation)

| Item | Value |
|------|--------|
| Device name | `ACD-` + last 4 hex of BT MAC (e.g. `ACD-A1B2`) |
| Status service | `a0cd0001-acd0-4c00-9c00-00805f9b34fb` |
| HEARTBEAT (notify) | `a0cd0002-acd0-4c00-9c00-00805f9b34fb` |
| INFO (read) | `a0cd0003-acd0-4c00-9c00-00805f9b34fb` |
| STATUS_CTRL (write) | `a0cd0010-acd0-4c00-9c00-00805f9b34fb` |
| STATUS_DATA (write / write-cmd) | `a0cd0011-acd0-4c00-9c00-00805f9b34fb` |
| STATUS_STATE (notify) | `a0cd0012-acd0-4c00-9c00-00805f9b34fb` |
| Max payload | **8192** bytes (PSRAM reassembly buffer) |

### Wire format (S2+)

**CTRL**

| Op | Bytes |
|----|--------|
| BEGIN `0x01` | `schema_version u8` + `total_len u16 LE` + `crc32 u32 LE` (8 bytes total incl. op) |
| ABORT `0x02` | op only |
| COMMIT `0x03` | op only |

**DATA:** `seq u16 LE` + payload slice (seq starts at 0, contiguous).

**CRC32:** IEEE / `zlib.crc32` / `esp_crc32_le` over the full reassembled body.

**STATE notify (ASCII):** `ok` \| `schema` \| `overflow` \| `busy` \| `bad_crc` \| `bad_len` \| `incomplete` \| `abort`

Host flow: subscribe STATE → BEGIN → DATA* → COMMIT → wait STATE.

## Host setup (macOS)

```bash
cd tools/ble_link
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Flash deck first, note name from serial: [ble] advertising as ACD-....
python connect_soak.py --duration 1800          # S1
python push_xfer.py --count 100                 # S2
python mock_bridge.py --animate                 # S3/S4 (kill → STALE)
```

- First run: allow **Bluetooth** for Terminal / IDE (System Settings → Privacy & Security).
- Keep the Mac awake (disable lid-sleep or use `caffeinate` during soak).
- Serial on deck: `cd deck && pio device monitor` — watch `[ble]` / `[status]` / `[ui]` lines; **never** log summary body text.

## Phase checklist

### S1 — Link

| Check | Result | Notes |
|-------|--------|-------|
| Advertise visible (`ACD-*`) | ☐ | |
| Host connect + INFO read | ☐ | |
| HEARTBEAT notify rate ~5 s | ☐ | |
| Connected ≥ **30 min** | ☐ | disconnect count: __ |
| Reconnect after host BT toggle | ☐ | |
| Free heap stable / no WDT | ☐ | min_free_heap: __ |
| Negotiated MTU | ☐ | mtu: __ |

**S1 run log**

```
date:
host OS:
deck fw:
duration:
connects / disconnects:
mtu:
min_free_heap:
pass/fail:
```

### S2 — Bulk transfer ✅ Lab pass

| Check | Result | Notes |
|-------|--------|-------|
| 100/100 clean transfers | **Pass** | `python push_xfer.py --count 100` after double-buffer + conservative chunk fix |
| CRC/len failures | **0** | Host reported 100 ok / 0 fail |
| Walk-around (same session) | **Pass** | Moved deck around house during soak; still 100/100 (reporting trusted as host STATE `ok` count) |
| MTU + duration recorded | ☐ | Fill from host log if desired |
| Optional pad stress | ☐ | `--pad-to 4096` or `8192` not required for pass |

**S2 run log**

```
date: 2026-07-20
host OS: macOS (bleak)
deck fw: spike S2–S4 (post reliability fix 21556ec+)
count ok/fail: 100/0
range notes: house walk-around during transfer soak — no failures
pass/fail: PASS
```

### S3 — On glass

| Check | Result | Notes |
|-------|--------|-------|
| Mock 3 sessions on glass | ☐ | `python mock_bridge.py --once` |
| Host change → redraw | ☐ | `mock_bridge.py --animate` |
| SCHEMA frame on bad version | ☐ | `push_xfer.py --payload payloads/schema_bad.json --schema-version 1` (BEGIN=1, body v99) or BEGIN≠1 → STATE schema |

### S4 — Bridge-shaped + STALE

| Check | Result | Notes |
|-------|--------|-------|
| 30 min soak stable | ☐ | `mock_bridge.py --interval 15` |
| Kill pusher → STALE within grace | ☐ | grace **30 s** |
| Restart → recovery redraw | ☐ | |
| Indoor range walk-test | ☐ | usable distance: __ |

**S4 run log**

```
date:
interval:
soak duration:
stale after kill (s):
recovery ok:
range notes:
min_free_heap:
pass/fail:
```

## Decision matrix (fill after S4)

| Result | Choice (circle one) |
|--------|---------------------|
| S4 pass + acceptable room range | BLE primary / keep USB desk |
| S4 pass but range short | BLE near-desk + **start Option B** |
| S1–S2 fail (stack/RAM/OS) | **Option B** + USB desk |
| Host cannot talk BLE | USB-only desk until RF path exists |

**Decision date / notes:**

```
date:
choice:
rationale:
```
