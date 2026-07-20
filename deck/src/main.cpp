/**
 * Agent Control Deck — multi-session status layout demo
 *
 * Target: LilyGo T5-ePaper (ESP32-WROVER), 960x540, 4-bit grayscale.
 * PR1b: compile-time DeckView fixture only (no JSON / radio).
 */

#ifndef BOARD_HAS_PSRAM
#error "PSRAM is required. Build with BOARD_HAS_PSRAM (see platformio.ini)."
#endif

#include <Arduino.h>
#include <string.h>

#include "display.h"
#include "status_model.h"
#include "ui_layout.h"

/** Compile-time demo fixture matching the product wireframe (~3 sessions). */
static void build_demo_view(DeckView *view)
{
    memset(view, 0, sizeof(*view));

    view->link_state = DECK_LINK_OK;
    view->stale = false;
    view->fault = DECK_FAULT_NONE;
    view->age_ms = 12000; /* 12s */
    strncpy(view->transport, "demo", sizeof(view->transport) - 1);
    strncpy(view->host_name, "brandon-mbp", sizeof(view->host_name) - 1);
    strncpy(view->bridge_version, "0.1.0", sizeof(view->bridge_version) - 1);
    view->schema_version = 1;
    view->last_schema_version = 1;
    view->refresh_count = 14;
    view->sessions_total = 3;
    view->row_count = 3;

    /* Row 0: * RUNNING with progress */
    DeckSessionRow *r0 = &view->rows[0];
    r0->state = DECK_STATE_RUNNING;
    strncpy(r0->agent, "mock", sizeof(r0->agent) - 1);
    strncpy(r0->title, "agent-control-deck", sizeof(r0->title) - 1);
    strncpy(r0->summary, "Implement WiFi poll + status layout", sizeof(r0->summary) - 1);
    strncpy(r0->detail, "Editing deck/src/ui_layout.cpp", sizeof(r0->detail) - 1);
    r0->has_progress = true;
    r0->progress = 0.45f;

    /* Row 1: o IDLE */
    DeckSessionRow *r1 = &view->rows[1];
    r1->state = DECK_STATE_IDLE;
    strncpy(r1->agent, "other", sizeof(r1->agent) - 1);
    strncpy(r1->title, "docs", sizeof(r1->title) - 1);
    strncpy(r1->summary, "No active task", sizeof(r1->summary) - 1);
    r1->has_progress = false;

    /* Row 2: ! ERROR */
    DeckSessionRow *r2 = &view->rows[2];
    r2->state = DECK_STATE_ERROR;
    strncpy(r2->agent, "mock", sizeof(r2->agent) - 1);
    strncpy(r2->title, "demo", sizeof(r2->title) - 1);
    strncpy(r2->summary, "Adapter failure", sizeof(r2->summary) - 1);
    strncpy(r2->error, "Adapter crash: permission denied /tmp/agent.log",
            sizeof(r2->error) - 1);
    r2->has_progress = false;
}

void setup()
{
    Serial.begin(115200);
    delay(500);
    Serial.println();
    Serial.println("agent-control-deck/deck: status layout demo (hardcoded DeckView)");

    if (!display_init()) {
        Serial.println("PSRAM framebuffer alloc failed");
        while (true) {
            delay(1000);
        }
    }

    DeckView view;
    build_demo_view(&view);

    ui_draw_status(display_framebuffer(), &view);
    display_present(/*full_clear=*/true);

    Serial.println("Demo status layout drawn to e-paper.");
}

void loop()
{
    /* Static demo fixture — nothing to refresh. */
    delay(10000);
}
