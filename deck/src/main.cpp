/**
 * Agent Control Deck — BLE spike S2–S4
 *
 * - Wi‑Fi off; NimBLE peripheral (link + chunked push).
 * - Committed payload → parse StatusSnapshot → DeckView → e-paper.
 * - STALE when no successful v1 commit within grace (or fail_count ≥ 2).
 * - Redraw only when *on-glass* content changes (not raw JSON CRC — every
 *   bridge push rewrites generated_at / updated_at). Full clear on each
 *   present (grayscale blit cannot erase prior ink — see display_present).
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

static DeckView g_view;
/** Last view actually painted (for glass equality — not the same as g_view). */
static DeckView g_presented;
static bool g_have_presented = false;
static bool g_had_ok = false;
static uint32_t g_last_ok_ms = 0;
static uint8_t g_fail_count = 0;
static uint32_t g_refresh_count = 0;
static uint32_t g_presents = 0;
static bool g_need_redraw = false;

/**
 * True when @p a and @p b would paint the same frame (except age_ms / refresh
 * tokens). Ignores host timestamps that change every bridge push.
 */
static bool glass_equal(const DeckView *a, const DeckView *b)
{
    if (!a || !b) {
        return false;
    }
    if (a->fault != b->fault || a->stale != b->stale || a->link_state != b->link_state) {
        return false;
    }
    if (a->fault == DECK_FAULT_SCHEMA) {
        return a->last_schema_version == b->last_schema_version;
    }
    if (a->row_count != b->row_count || a->sessions_total != b->sessions_total) {
        return false;
    }
    if (a->count_error != b->count_error || a->count_waiting != b->count_waiting ||
        a->count_done != b->count_done || a->count_running != b->count_running) {
        return false;
    }
    /* transport / host not drawn on design C top bar beyond fixed "BLE". */
    for (uint8_t i = 0; i < a->row_count; i++) {
        const DeckSessionRow *ra = &a->rows[i];
        const DeckSessionRow *rb = &b->rows[i];
        if (ra->state != rb->state) {
            return false;
        }
        if (strcmp(ra->title, rb->title) != 0) {
            return false;
        }
        /* Row body: error text wins when state is error (ui_layout). */
        const char *ba = (ra->state == DECK_STATE_ERROR && ra->error[0]) ? ra->error : ra->summary;
        const char *bb = (rb->state == DECK_STATE_ERROR && rb->error[0]) ? rb->error : rb->summary;
        if (strcmp(ba, bb) != 0) {
            return false;
        }
    }
    return true;
}

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

    ui_draw_status(display_framebuffer(), &g_view);
    /* Always full clear + full frame (see display_present). */
    display_present(true);
    g_presents++;
    g_presented = g_view;
    g_have_presented = true;
    g_need_redraw = false;
    Serial.printf("[ui] present full=1 fault=%u stale=%u rows=%u refresh=%u heap=%u\n",
                  (unsigned)g_view.fault, (unsigned)g_view.stale, (unsigned)g_view.row_count,
                  (unsigned)g_refresh_count, (unsigned)ESP.getFreeHeap());
}

/**
 * Outcome A — valid v1.
 * Accept every good push (reset STALE grace) but only flash the panel when the
 * painted view would change. Body CRC alone is useless: generated_at and
 * session updated_at change on every bridge poll.
 */
static void apply_outcome_a(void)
{
    g_fail_count = 0;
    g_view.fault = DECK_FAULT_NONE;
    g_view.stale = false;
    g_view.link_state = DECK_LINK_OK;
    g_last_ok_ms = millis();
    g_had_ok = true;
    g_refresh_count++;

    const bool glass_changed = !g_have_presented || !glass_equal(&g_presented, &g_view);

    if (glass_changed) {
        g_need_redraw = true;
        Serial.printf("[status] outcome A — ok redraw=1 rows=%u\n", (unsigned)g_view.row_count);
    } else {
        Serial.printf("[status] outcome A — ok (no redraw, glass unchanged) rows=%u\n",
                      (unsigned)g_view.row_count);
    }
}

/** Outcome B — unsupported schema_version. */
static void apply_outcome_b(void)
{
    const bool already = g_view.fault == DECK_FAULT_SCHEMA;
    g_view.fault = DECK_FAULT_SCHEMA;
    if (!already) {
        g_need_redraw = true;
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
