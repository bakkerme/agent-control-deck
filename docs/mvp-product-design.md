# Agent Control Deck — MVP Product & System Design (Read-Only Status Display)

| Field | Value |
|-------|--------|
| **Document** | Product Design / System Design — MVP |
| **Author** | TBD |
| **Date** | 2026-07-20 |
| **Status** | Draft (rev 2.9 — BLE closed; schema PR2 ✅; bridge ingress+egress PR3a/PR3b/PR6a ✅; design-D UI; quickstart PR10 ✅) |
| **Scope** | Read-only agent status on LilyGo T5-ePaper |
| **Repo** | `agent-control-deck` (this monorepo) |

---

## Overview

**Agent Control Deck** is a desk- and room-portable **e-paper status display** for AI coding agents. Despite the product name, the MVP is a **status deck only**: a **read-only** glanceable view of agent state (name, task summary, running/idle/error, progress, last update) so a developer can leave their phone in their pocket while agents run on a host machine. **Control features (kill, approve, inject prompt, or any intervention) are a future product generation, not a hidden MVP toggle.**

Today the monorepo has a **working MVP product pipe**: LilyGo T5-ePaper firmware (design **D · 7 rows**, NimBLE peripheral, STALE ~30 s) + **`bridge/`** (hooks/file/mock → store → **`acd-bridge push-ble`**) + formal **`schema/`** package. USB exclusive mode and scrapers remain deferred. Tickets: [`docs/pr-plan.md`](pr-plan.md).

**Transport decision (rev 2.7 — locked):** host machines may be **firewalled against inbound TCP**; SoftAP is **not viable**; third-host status is a **compliance risk**. The BLE spike is **closed**: **BLE host-push is the primary portable path**; **USB serial remains desk/debug exclusive mode**; **Option B (LAN reverse-push) is deferred**. Evidence and residual notes live in [`docs/ble-spike.md`](ble-spike.md). Control/intervention is **explicitly out of scope**.

---

### Hardware facts

| Item | Value |
|------|--------|
| Board | LilyGo T5-ePaper (classic **ESP32-WROVER**, not S3) |
| Panel | 4.7", **960×540**, 4-bit grayscale (packed 2 pixels/byte) |
| Framebuffer | `EPD_WIDTH * EPD_HEIGHT / 2` = **259,200 bytes** in PSRAM (`ps_calloc`) |
| Display API | LilyGo-EPD47 / epdiy: `epd_init`, `epd_poweron/off`, `epd_clear`, `epd_clear_area`, `epd_draw_grayscale_image`, `epd_fill_rect`, `writeln` + FiraSans |
| Connectivity | WiFi + Bluetooth (board JSON); USB for flash/serial (~460800 upload, 115200 monitor on UART0) |
| Buttons (classic ESP32) | `BUTTON_1=34`, `BUTTON_2=35`, `BUTTON_3=39` ([`utilities.h`](https://github.com/Xinyuan-LilyGO/LilyGo-EPD47/blob/master/src/utilities.h) in sibling LilyGo-EPD47) |
| Battery sense | `BATT_PIN=36` (ADC). LilyGo `demo.ino`: **must `epd_poweron()` (POWER_EN) before `analogRead(BATT_PIN)`**. Treat battery UI as **off by default** until validated on the physical revision |
| Full refresh | Multi-second flash class (~1–3 s typical; **measure on hardware**); design for infrequent full updates |
| Deep sleep | Supported (LilyGo `examples/sleep`); `epd_poweroff_all` + timer wake |
| Classic ESP32 caveat | LilyGo notes that **not all examples fully work** on classic ESP32 env; soak-test WiFi + PSRAM framebuffer together |

### Pain points the product addresses

1. **Phone-pull tax**: Checking whether a long agent run finished requires unlocking a phone or switching desktop focus.
2. **Ambient awareness**: Agent work is background; status belongs on a low-power always-visible surface, not a glowing LCD.
3. **Portable glance**: User may carry the **deck** to another room while the **host stays on the desk** (same SSID / stable host IP). WiFi status follows the deck without carrying a laptop screen.
4. **E-paper fit**: Infrequent updates and high contrast text match agent state changes (minutes, not milliseconds).

### Persona

**Primary:** Solo or small-team developer running local AI coding agents (Claude Code, Codex CLI, Cursor agent mode, Aider, custom scripts) on a workstation or laptop on the same LAN (or USB-tethered).

**Secondary (deferred UX):** Multi-machine / cloud agent sessions — data model should not forbid them, but MVP integration is **file/POST hooks on one host**, not cloud multi-tenant.

---

## Goals & Non-Goals

### Goals (MVP)

1. **Glanceable status**: From ~1–2 m, user can tell: is anything running? which agent? what task? healthy or error?
2. **Read-only status deck only**: Display status; no send, kill, approve, or interactive control. Control is a later generation.
3. **Desk + room use**: USB-powered desk mode works; WiFi enables untethered room-to-room glance of the **deck** while host remains on a **stable LAN IP** (same SSID).
4. **Host bridge**: A small host-side process collects/normalizes agent status and serves it to the deck.
5. **Stable status model**: Versioned JSON schema for agents/sessions that firmware and host share.
6. **Honest offline UX**: Clear “disconnected / stale” presentation when host unreachable (including host sleep / IP change).
7. **Incremental delivery**: Mergeable PRs from hello-world → layout → mock status → WiFi → bridge → file/POST integration.
8. **Power-aware refresh**: Panel powered only during draw; poll interval suitable for e-paper (tens of seconds).

### Non-Goals (MVP)

| Non-goal | Rationale |
|----------|-----------|
| Agent control (stop, approve, inject prompt) | Explicit product constraint; future generation, not MVP toggle |
| Multi-page dashboards / touch UI | Buttons exist; paging deferred; touch not required |
| Cloud SaaS / accounts / multi-user auth | Local-only trust model |
| Perfect partial-refresh ghost-free UI | Full-frame strategy is enough for MVP |
| First-party adapter for every agent CLI | **Supported MVP integration = file/POST hooks**; named agent scrapers deferred |
| SoftAP on the deck (host joins device AP) | Host must keep its normal Wi‑Fi for agents/internet |
| Host TCP status server when inbound is firewalled | Product constraint: cannot rely on opening host listen ports |
| Third-party / off-box status relay | Compliance risk for agent/task text that may contain secrets |
| Mobile app companion | Phone is what we’re avoiding |
| mDNS host discovery | Deferred unless a future LAN transport needs it |
| SNTP / wall clock on device | Deferred; relative `millis()` age only |
| Beautiful multi-font graphic design | Functional FiraSans + ASCII tokens first |
| Classic ESP32 Wi‑Fi + BLE concurrent radios in first spike | Avoid coexistence complexity; BLE spike is BLE-only |

### Success metrics

| Metric | Target (MVP) |
|--------|----------------|
| Time to first meaningful status after boot (desk, transport linked) | &lt; 30 s |
| Status freshness when connected | ≤ poll interval + 5 s (default poll **15 s**) + draw time |
| User glance comprehension | Identify “running vs idle vs error” in &lt; 2 s without reading body text |
| Disconnected clarity | “STALE” / “NO LINK” visible when **`fail_count >= 2`** (i.e. after **two consecutive failed polls**, ~**30 s** at 15 s poll) — see [Offline policy](#offline--disconnected-behavior) |
| Full-screen refresh rate | ≤ **2 full flashes/minute** under steady state (change-driven only; no 60 s heartbeat redraw) |
| Host bridge idle CPU | Negligible (&lt; 1% on laptop when no agents) |
| Firmware crash rate | No watchdog resets during 8 h continuous poll test (PR5 acceptance + soak checklist) |

### Product assumptions (portable story)

**Provisional** until the [BLE transport spike](#ble-transport-spike) completes. Two portable models are in play:

**A. BLE-primary (preferred if spike passes)**

1. **Host keeps its normal Wi‑Fi** (agents/internet). Deck does **not** require SoftAP.
2. **Host does not open inbound TCP** for status. Bridge is a **BLE central** that pushes snapshots.
3. **Portable = deck moves within BLE range** of the host; host stays on the desk. Out of range / host sleep → **STALE is expected**.
4. Status RF stays host↔deck (not corporate LAN / third host) — preferred compliance posture.

**B. LAN reverse-push “Option B” (fallback if BLE fails range/reliability)**

1. Deck joins the same SSID as STA and **listens**; host **outbound-only** POSTs snapshots (host still does not need an inbound port).
2. Requires accepting agent/task text on the LAN; not SoftAP; not a third-party relay.
3. Stable deck addressing (DHCP reservation or documented discovery) becomes a product assumption again.

**Shared**

- Desk tethered path: **USB NDJSON** exclusive mode (no radio).
- Host-as-server device-pull (`GET` host:8787) is **not** a reliable product assumption under host firewall policy.
- mDNS / captive portal / NVS config UI remain post-spike unless Option B needs minimal discovery.

---

## Proposed Design

### System architecture

Three logical components:

1. **Deck firmware** (`deck/`) — ESP32: receive status snapshot (BLE, USB, and/or future LAN push), render e-paper, wait, repeat.
2. **Host bridge** (`bridge/` — new) — process on the developer machine: collect agent status, **push** snapshot to the deck (BLE central and/or USB writer; LAN reverse-push only if Option B is selected). Optional localhost HTTP is for tools/adapters only, not for the firewalled “serve the deck” path.

### Why host bridge (not agents talking to the device directly)

No API availability for most agents, only hooks.

### Transport strategy

| Path | Role | Status |
|------|------|--------|
| **BLE host-push (primary portable)** | Deck = GATT peripheral; host bridge = BLE central; chunked `StatusSnapshot` write | **Locked** — spike closed; production egress still **PR3b** (promote `tools/ble_link/`) |
| **USB serial (desk/debug, exclusive mode)** | Host writes NDJSON snapshots; device reads UART0 | Planned secondary (**PR7**); not concurrent with radio modes |


## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| K1 | **MVP = read-only status only**; control is a future generation | Product cut line; avoids safety/protocol scope |
| K2 | **Portable transport under re-decision via BLE spike**; prefer **host-push** over host-listen | Host may be firewalled; SoftAP rejected |
| K3 | **Secondary transport = USB NDJSON exclusive mode** | Desk/debug; no dual-use UART conflict |
| K4 | **Host bridge process required** | Aggregate heterogeneous sources |
| K5 | **Python bridge for MVP** (`bleak` for BLE central) | Fast adapter/hook iteration + cross-platform BLE |
| K6 | **Versioned JSON StatusSnapshot (`schema_version`)** | Single contract across BLE / USB / future LAN |
| K7 | **Default update cadence ~15 s; full-frame redraw on content/fault change only** | E-paper strengths; no heartbeat flash for age ticks |
| K8 | **Display + bridge default cap = 7 sessions** (design D · 20px) | Glass legibility; optional `sessions_total` / `state_counts` for top-bar `+N` and tallies |
| K9 | **Supported MVP integration = mock + file + loopback POST hooks**; scrapers **deferred** | Clear script mental model; no reverse-engineering CLIs |
| K10 | **Prefer RF/USB that keeps summaries off the LAN**; adapter HTTP writes stay loopback-only | Firewall + compliance constraints |
| K11 | **SoftAP rejected**; stable host IP / device-pull WiFi **not** product primary | Host must keep Wi‑Fi; host may not listen |
| K12 | **Stay on classic ESP32 / existing PlatformIO env** | Hardware in hand |
| K13 | **STALE when `fail_count >= 2`** from transport failures; device `millis()` only; **SCHEMA > STALE** | One offline policy; no RTC |
| K14 | **No reliance on LAN GET bearer token for MVP** | BLE path avoids LAN GET; Option B may revisit tokens |
| K15 | **No device SNTP; UI age = `millis() - last_ok_ms`** | Avoid false precision from unset wall clock |
| K16 | **ASCII state tokens + geometric progress bar** | FiraSans glyph safety |
| K17 | **mDNS deferred** until Option B needs discovery | BLE uses advertise/scan names |
| K18 | **Run BLE spike S1–S4 before Option B or WiFi pull PRs** | Measure range, RAM, OS BLE before locking architecture |
| K19 | **BLE spike = deck peripheral + host central; Wi‑Fi off on deck** | Avoid SoftAP and Wi‑Fi+BLE coexistence in validation |


---

## References

- Repo: `/Users/brandon/sources/agent-control-deck/README.md`
- Firmware: `/Users/brandon/sources/agent-control-deck/deck/`
- Entry: `/Users/brandon/sources/agent-control-deck/deck/src/main.cpp`
- PlatformIO: `/Users/brandon/sources/agent-control-deck/deck/platformio.ini`
- Board JSON: `/Users/brandon/sources/agent-control-deck/deck/boards/T5-ePaper.json`
- Display driver: `/Users/brandon/sources/LilyGo-EPD47` (`epd_driver.h`, `firasans.h`, `utilities.h`, `library.json`)
- **HTTP client + JSON + EPD reference:** `/Users/brandon/sources/LilyGo-EPD47/examples/ha_calendar/ha_calendar.ino`
- Battery POWER_EN note: `/Users/brandon/sources/LilyGo-EPD47/examples/demo/demo.ino`
- Sleep: `/Users/brandon/sources/LilyGo-EPD47/examples/sleep/sleep.ino`
- Device-as-server (rejected pattern): `/Users/brandon/sources/LilyGo-EPD47/examples/wifi_sync/wifi_sync.ino`
- ArduinoJson pin in LilyGo example env: `/Users/brandon/sources/LilyGo-EPD47/platformio.ini` (`bblanchon/ArduinoJson@^7.4.2`)
- Upstream: [vroland/epdiy](https://github.com/vroland/epdiy)
- Product family: [LilyGo T5 4.7" e-paper](https://www.lilygo.cc/products/t5-4-7-inch-e-paper-v2-3)

---

## PR Plan

Ticket list, merge order, and done definitions live in **[`docs/tickets/pr-plan.md`](tickets/pr-plan.md)**

---

*End of design document (rev 2.8).*
