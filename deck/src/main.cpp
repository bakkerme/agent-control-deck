/**
 * Agent Control Deck — BLE spike S2–S4
 *
 * - Wi‑Fi off; NimBLE peripheral (link + chunked push).
 * - Committed payload → parse StatusSnapshot → DeckView → e-paper.
 * - STALE when no successful v1 commit within grace (or fail_count ≥ 2).
 */

#ifndef BOARD_HAS_PSRAM
#error "PSRAM is required. Build with BOARD_HAS_PSRAM (see platformio.ini)."
#endif

#include <Arduino.h>
#include <WiFi.h>
#include <string.h>

#include "ble_gatt.h"
#include "display.h"
#include "status_model.h"
#include "status_parse.h"
#include "ui_layout.h"

/** No successful commit for this long → STALE (S4; ~2× 15 s bridge cadence). */
static const uint32_t kStaleGraceMs = 30000;
/** Full panel clear every N successful content redraws (ghosting mitigation). */
static const uint32_t kFullClearEvery = 12;

static DeckView g_view;
static bool g_had_ok = false;
static uint32_t g_last_ok_ms = 0;
static uint8_t g_fail_count = 0;
static uint32_t g_refresh_count = 0;
static uint32_t g_presents = 0;
static bool g_need_redraw = false;
static bool g_force_full_clear = true;

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

/** Outcome A — valid v1 snapshot content already written into g_view by parser. */
static void apply_outcome_a(void)
{
    g_fail_count = 0;
    g_view.fault = DECK_FAULT_NONE;
    g_view.stale = false;
    g_view.link_state = DECK_LINK_OK;
    g_last_ok_ms = millis();
    g_had_ok = true;
    g_refresh_count++;
    g_need_redraw = true;
    g_force_full_clear = true; /* recovery / content change: clean frame */
    Serial.println("[status] outcome A — ok");
}

/** Outcome B — unsupported schema_version. */
static void apply_outcome_b(void)
{
    g_view.fault = DECK_FAULT_SCHEMA;
    /* Do not increment fail_count; do not set stale for SCHEMA frame. */
    g_need_redraw = true;
    g_force_full_clear = true;
    Serial.printf("[status] outcome B — schema last=%d\n", g_view.last_schema_version);
}

/** Outcome C — transport / parse failure. */
static void apply_outcome_c(const char *why)
{
    if (g_view.fault == DECK_FAULT_SCHEMA) {
        /* Keep SCHEMA on glass until a good v1 arrives. */
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
    g_view.link_state = DECK_LINK_DOWN;
    g_view.stale = true;
    g_need_redraw = true;
    Serial.printf("[status] outcome C fail_count=%u (%s) — STALE\n", (unsigned)g_fail_count,
                  why ? why : "?");
}

static void handle_committed_payload(const uint8_t *data, size_t len)
{
    Serial.printf("[status] committed bytes=%u heap=%u\n", (unsigned)len,
                  (unsigned)ESP.getFreeHeap());

    DeckView parsed;
    memset(&parsed, 0, sizeof(parsed));
    /* Preserve display policy fields; parser fills content. */
    parsed.link_state = g_view.link_state;
    parsed.stale = g_view.stale;
    parsed.fault = g_view.fault;
    parsed.age_ms = g_view.age_ms;
    parsed.refresh_count = g_view.refresh_count;
    strncpy(parsed.transport, "ble", sizeof(parsed.transport) - 1);

    const StatusParseResult pr = status_parse_snapshot(data, len, &parsed);
    if (pr == STATUS_PARSE_OK) {
        /* Keep cached content replacement. */
        g_view = parsed;
        apply_outcome_a();
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
    /* Grace exceeded without a successful commit — force STALE path. */
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
    Serial.println("agent-control-deck/deck: PR-S2..S4 BLE spike");

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

    Serial.println("[ble] ready — tools/ble_link/push_xfer.py | mock_bridge.py");
}

void loop()
{
    ble_gatt_poll();

    const uint8_t *payload = nullptr;
    size_t plen = 0;
    if (ble_gatt_take_committed(&payload, &plen)) {
        handle_committed_payload(payload, plen);
    }

    check_stale_grace();

    if (g_need_redraw) {
        present_view();
    }

    delay(20);
}
