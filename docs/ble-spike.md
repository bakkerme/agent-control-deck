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
| STATUS_CTRL (S2) | `a0cd0010-acd0-4c00-9c00-00805f9b34fb` |
| STATUS_DATA (S2) | `a0cd0011-acd0-4c00-9c00-00805f9b34fb` |
| STATUS_STATE (S2) | `a0cd0012-acd0-4c00-9c00-00805f9b34fb` |
| Max payload (planned) | 8192 bytes |

## Host setup (macOS)

```bash
cd tools/ble_link
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Flash deck first, note name from serial: [ble] advertising as ACD-....
python connect_soak.py --duration 1800   # 30 min acceptance
```

- First run: allow **Bluetooth** for Terminal / IDE (System Settings → Privacy & Security).
- Keep the Mac awake (disable lid-sleep or use `caffeinate` during soak).
- Serial on deck: `cd deck && pio device monitor` — watch `[ble]` lines and heap.

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

**S1 run log (copy Serial / host output highlights)**

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

### S2 — Bulk transfer

| Check | Result | Notes |
|-------|--------|-------|
| 100/100 clean 2–8 KiB transfers | ☐ | |
| CRC/len failures | ☐ | count: __ |
| MTU + duration recorded | ☐ | |

### S3 — On glass

| Check | Result | Notes |
|-------|--------|-------|
| Mock 3 sessions on glass | ☐ | |
| Host change → redraw ≤ heartbeat + draw | ☐ | |

### S4 — Bridge-shaped + STALE

| Check | Result | Notes |
|-------|--------|-------|
| 30 min soak stable | ☐ | |
| Kill pusher → STALE within grace | ☐ | |
| Restart → recovery redraw | ☐ | |
| Indoor range walk-test | ☐ | usable distance: __ |

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
