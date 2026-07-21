/**
 * Agent Control Deck — BLE spike S2–S4
 *
 * - Wi‑Fi off; NimBLE peripheral (link + chunked push).
 * - Committed payload → parse StatusSnapshot → DeckView → e-paper.
 * - STALE when no successful v1 commit within grace (or fail_count ≥ 2).
 * - Redraw only when content/fault/stale actually changes (S2 soak must not
 *   full-refresh the panel 100 times).
 */

#ifndef BOARD_HAS_PSRAM
#error "PSRAM is required. Build with BOARD_HAS_PSRAM (see platformio.ini)."
#endif

#include <Arduino.h>
#include <WiFi.h>
#include <esp_crc.h>
#include <string.h>

#include "ble_gatt.h"
#include "display.h"
#include "status_model.h"
#include "status_parse.h"
#include "ui_layout.h"

/** No successful commit for this long → STALE (S4; ~2× 15 s bridge cadence). */
static const uint32_t kStaleGraceMs = 30000;
/** Full panel clear every N content redraws (ghosting mitigation). */
static const uint32_t kFullClearEvery = 12;

static DeckView g_view;
static bool g_had_ok = false;
static uint32_t g_last_ok_ms = 0;
static uint8_t g_fail_count = 0;
static uint32_t g_refresh_count = 0;
static uint32_t g_presents = 0;
static bool g_need_redraw = false;
static bool g_force_full_clear = true;
/** CRC32 of last successfully applied payload body (for change detection). */
static uint32_t g_last_body_crc = 0;
static bool g_have_body_crc = false;

static void build_boot_view(DeckView *view)
{
    memset(view, 0, sizeof(*view));
    view->link_state = DECK_LINK_DOWN;
    view->stale = false;
    view->fault = DECK_FAULT_NONE;
    view->age_ms = 0;
    strncpy(view->transport, "ble", sizeof(view->transport) - 1);
    strncpy(view->host_name, "--", sizeof(view->host_name) - 1);
    strncpy(view->bridge_version, "--", sizeof(view->bridge_version) - 1);
    view->schema_version = 1;
    view->last_schema_version = 1;
    view->refresh_count = 0;
    view->sessions_total = 0;
    view->row_count = 0;
}

static void present_view(void)
{
    g_view.transport[0] = '\0';
    strncpy(g_view.transport, "ble", sizeof(g_view.transport) - 1);
    g_view.refresh_count = g_refresh_count;
    if (g_had_ok) {
        g_view.age_ms = millis() - g_last_ok_ms;
    } else {
        g_view.age_ms = 0;
    }

    const bool full = g_force_full_clear || (g_presents % kFullClearEvery == 0);
    ui_draw_status(display_framebuffer(), &g_view);
    display_present(full);
    g_presents++;
    g_force_full_clear = false;
    g_need_redraw = false;
    Serial.printf("[ui] present full=%u fault=%u stale=%u rows=%u refresh=%u heap=%u\n",
                  (unsigned)full, (unsigned)g_view.fault, (unsigned)g_view.stale,
                  (unsigned)g_view.row_count, (unsigned)g_refresh_count,
                  (unsigned)ESP.getFreeHeap());
}

/** Outcome A — valid v1; redraw only when body CRC changed or recovering from fault/stale. */
static void apply_outcome_a(uint32_t body_crc)
{
    const bool was_bad = g_view.stale || g_view.fault != DECK_FAULT_NONE ||
                         g_view.link_state != DECK_LINK_OK;
    const bool content_changed = !g_have_body_crc || body_crc != g_last_body_crc;

    g_fail_count = 0;
    g_view.fault = DECK_FAULT_NONE;
    g_view.stale = false;
    g_view.link_state = DECK_LINK_OK;
    g_last_ok_ms = millis();
    g_had_ok = true;
    g_refresh_count++;
    g_last_body_crc = body_crc;
    g_have_body_crc = true;

    if (content_changed || was_bad) {
        g_need_redraw = true;
        /* Full clear on recovery/fault clear; content-only updates can partial-present. */
        g_force_full_clear = was_bad;
        Serial.printf("[status] outcome A — ok redraw=1 crc=0x%08x\n", (unsigned)body_crc);
    } else {
        /* S2 soak: same payload again — accept, do not flash e-paper. */
        Serial.printf("[status] outcome A — ok (no redraw, same crc=0x%08x)\n",
                      (unsigned)body_crc);
    }
}

/** Outcome B — unsupported schema_version. */
static void apply_outcome_b(void)
{
    const bool already = g_view.fault == DECK_FAULT_SCHEMA;
    g_view.fault = DECK_FAULT_SCHEMA;
    if (!already) {
        g_need_redraw = true;
        g_force_full_clear = true;
    }
    Serial.printf("[status] outcome B — schema last=%d redraw=%u\n", g_view.last_schema_version,
                  (unsigned)g_need_redraw);
}

/** Outcome C — transport / parse failure. */
static void apply_outcome_c(const char *why)
{
    if (g_view.fault == DECK_FAULT_SCHEMA) {
        Serial.printf("[status] outcome C while SCHEMA (%s) — keep SCHEMA\n", why ? why : "?");
        return;
    }
    if (g_fail_count < 255) {
        g_fail_count++;
    }
    if (g_fail_count == 1) {
        g_view.link_state = DECK_LINK_DEGRADED;
        Serial.printf("[status] outcome C fail_count=1 (%s) — degraded, no forced redraw\n",
                      why ? why : "?");
        return;
    }
    const bool already_stale = g_view.stale;
    g_view.link_state = DECK_LINK_DOWN;
    g_view.stale = true;
    if (!already_stale) {
        g_need_redraw = true;
    }
    Serial.printf("[status] outcome C fail_count=%u (%s) — STALE redraw=%u\n",
                  (unsigned)g_fail_count, why ? why : "?", (unsigned)g_need_redraw);
}

static void handle_committed_payload(const uint8_t *data, size_t len)
{
    const uint32_t body_crc = esp_crc32_le(0, data, (uint32_t)len);
    Serial.printf("[status] committed bytes=%u crc=0x%08x heap=%u\n", (unsigned)len,
                  (unsigned)body_crc, (unsigned)ESP.getFreeHeap());

    DeckView parsed;
    memset(&parsed, 0, sizeof(parsed));
    parsed.link_state = g_view.link_state;
    parsed.stale = g_view.stale;
    parsed.fault = g_view.fault;
    parsed.age_ms = g_view.age_ms;
    parsed.refresh_count = g_view.refresh_count;
    strncpy(parsed.transport, "ble", sizeof(parsed.transport) - 1);

    const StatusParseResult pr = status_parse_snapshot(data, len, &parsed);
    if (pr == STATUS_PARSE_OK) {
        g_view = parsed;
        apply_outcome_a(body_crc);
        return;
    }
    if (pr == STATUS_PARSE_SCHEMA) {
        g_view.last_schema_version = parsed.last_schema_version;
        apply_outcome_b();
        return;
    }
    apply_outcome_c("parse");
}

static void check_stale_grace(void)
{
    if (!g_had_ok) {
        return;
    }
    if (g_view.fault == DECK_FAULT_SCHEMA) {
        return;
    }
    if (g_view.stale) {
        return;
    }
    if ((uint32_t)(millis() - g_last_ok_ms) < kStaleGraceMs) {
        return;
    }
    if (g_fail_count < 2) {
        g_fail_count = 2;
    }
    g_view.link_state = DECK_LINK_DOWN;
    g_view.stale = true;
    g_need_redraw = true;
    Serial.println("[status] STALE grace exceeded");
}

void setup()
{
    Serial.begin(115200);
    delay(500);
    Serial.println();
    Serial.println("agent-control-deck/deck: BLE status (design C · 8 rows)");

    WiFi.mode(WIFI_OFF);
    Serial.println("[wifi] mode=OFF");

    if (!display_init()) {
        Serial.println("PSRAM framebuffer alloc failed");
        while (true) {
            delay(1000);
        }
    }

    build_boot_view(&g_view);
    g_need_redraw = true;
    g_force_full_clear = true;
    present_view();

    if (!ble_gatt_begin()) {
        Serial.println("[ble] init failed — halt");
        while (true) {
            delay(1000);
        }
    }

    Serial.println("[ble] ready — acd-bridge push-ble | tools/ble_link/*");
}

void loop()
{
    ble_gatt_poll();

    /* Drain all queued commits before blocking on e-paper. */
    const uint8_t *payload = nullptr;
    size_t plen = 0;
    while (ble_gatt_take_committed(&payload, &plen)) {
        handle_committed_payload(payload, plen);
        payload = nullptr;
        plen = 0;
    }

    check_stale_grace();

    if (g_need_redraw) {
        present_view();
    }

    delay(5);
}
