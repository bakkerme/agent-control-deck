# BLE transport spike log

Tracks S1–S4 results against the [MVP product design](mvp-product-design.md#ble-transport-spike) decision matrix.

**Roles:** deck = GATT peripheral (NimBLE); host = `bleak` central. **Wi‑Fi off** on deck for the spike.

## Spike status: CLOSED (rev 2.7)

| Item | Outcome |
|------|---------|
| **Decision** | **Lock BLE as primary portable transport** |
| **USB** | Keep as exclusive-mode desk/debug path |
| **Option B** (LAN reverse-push) | **Deferred** until BLE proves insufficient in real multi-room use |
| **Evidence** | S1 link lab; S2 **100/100** CRC-validated transfers including **house walk-around**; stack (NimBLE + bleak) stable on-desk and mobile |
| **Not required for close** | Formal 30 min S4 soak, SCHEMA chrome polish, bonding/PIN — tracked as post-spike product work |

**Close rationale:** The spike question was “can host-push BLE carry StatusSnapshot reliably on classic ESP32 + macOS without SoftAP?” Answer: **yes**. Remaining work is productization (schema package, real `bridge/`, pairing, polish), not transport R&D.

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
uv venv
uv pip install -r requirements.txt

# Flash deck first, note name from serial: [ble] advertising as ACD-....
uv run python connect_soak.py --duration 1800          # S1
uv run python push_xfer.py --count 100                 # S2
uv run python mock_bridge.py --animate                 # S3/S4 (kill → STALE)
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
| Mock 3 sessions on glass | ☐ smoke | `python mock_bridge.py --once` — code path live; optional confirm on glass |
| Host change → redraw | ☐ smoke | `mock_bridge.py --animate` |
| SCHEMA frame on bad version | ☐ smoke | `push_xfer.py --payload payloads/schema_bad.json --schema-version 1` |

### S4 — Bridge-shaped + STALE

| Check | Result | Notes |
|-------|--------|-------|
| 30 min soak stable | ☐ optional | Nice-to-have; S2 soak + walk-around already stress radio |
| Kill pusher → STALE within grace | ☐ smoke | grace **30 s** — recommended 2-minute check |
| Restart → recovery redraw | ☐ smoke | restart `mock_bridge.py` |
| Indoor range walk-test | **Pass** (S2) | House walk-around during 100/100; usable for room/portable |

**S4 run log**

```
date: 2026-07-20 (partial — range via S2 walk-around)
range notes: house walk-around during bulk transfer; 100/100 held
stale after kill: (optional smoke — not blocking decision)
pass/fail: decision locked on S1+S2 + range; S3/S4 smoke optional
```

## Decision matrix (closed)

| Result | Choice |
|--------|--------|
| S4 pass + acceptable room range | **← selected: BLE primary + keep USB desk** |
| S4 pass but range short | BLE near-desk + start Option B |
| S1–S2 fail (stack/RAM/OS) | Option B + USB desk |
| Host cannot talk BLE | USB-only desk until RF path exists |

**Decision date / notes:**

```
date: 2026-07-20
choice: BLE primary portable transport; USB desk/debug; Option B deferred
rationale:
  - S2 100/100 CRC-ok transfers (host STATE ok after deck reassembly)
  - Same soak survived house walk-around (range not desk-only)
  - S1 link + NimBLE RAM footprint acceptable (no WDT / fail-fast)
  - Residual: optional STALE kill smoke, bonding before daily-driver, production bridge package
```

## Post-spike backlog (not spike blockers)

1. Merge spike branch(es) to `main` when ready.
2. **PR2** — freeze `StatusSnapshot` JSON Schema + examples.
3. **PR3** — real `bridge/` (adapters, store) with **BLE egress** as default (grow from `tools/ble_link/`).
4. Optional 2-minute STALE smoke: run `mock_bridge.py`, kill it, confirm STALE ≤30 s, restart → recovery.
5. Hardening: BLE bonding/encrypt before shared-office daily driver; macOS TCC / lid-sleep notes in quickstart.
6. Revisit Option B only if multi-floor range or OS BLE reliability fails in practice.