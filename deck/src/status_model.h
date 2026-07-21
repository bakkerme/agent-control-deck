/**
 * Device-local view model for the e-paper status layout (design C · 8 @ ~18–22px).
 *
 * C structs only — JSON parse lives in status_parse.* (ArduinoJson).
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

/** Hard cap matching bridge default display_limit / on-glass row count. */
#define DECK_MAX_ROWS 8

/** Fixed buffer sizes (include trailing NUL); match schema truncation guidance. */
#define DECK_STR_AGENT 25
#define DECK_STR_TITLE 33
#define DECK_STR_SUMMARY 97
#define DECK_STR_DETAIL 81
#define DECK_STR_ERROR 81
#define DECK_STR_HOST 33
#define DECK_STR_BRIDGE 17
#define DECK_STR_TRANSPORT 12

typedef enum {
    DECK_STATE_RUNNING = 0,
    DECK_STATE_IDLE,
    DECK_STATE_WAITING,
    DECK_STATE_ERROR,
    DECK_STATE_DONE,
    DECK_STATE_UNKNOWN,
} DeckSessionState;

typedef enum {
    DECK_LINK_OK = 0,
    DECK_LINK_DEGRADED,
    DECK_LINK_DOWN,
} DeckLinkState;

typedef enum {
    DECK_FAULT_NONE = 0,
    DECK_FAULT_SCHEMA,
} DeckFault;

/** One on-glass session row (strings already truncated for display). */
typedef struct {
    DeckSessionState state;
    char agent[DECK_STR_AGENT];
    char title[DECK_STR_TITLE];   /**< path column */
    char summary[DECK_STR_SUMMARY];
    char detail[DECK_STR_DETAIL];
    char error[DECK_STR_ERROR];
    bool has_progress; /**< retained from JSON; design-D UI does not draw bars */
    float progress;
} DeckSessionRow;

/**
 * Full-screen view model. Frame priority (highest wins):
 *   1. fault == SCHEMA → schema fault frame
 *   2. stale && row_count == 0 → full-screen NO LINK
 *   3. normal top bar + optional STALE banner + 0–8 rows (no footer)
 */
typedef struct {
    DeckLinkState link_state;
    bool stale;
    DeckFault fault;
    uint32_t age_ms; /**< relative age of last good snapshot (device millis) */

    char transport[DECK_STR_TRANSPORT]; /**< "ble", "usb", "demo", ... */
    char host_name[DECK_STR_HOST];
    char bridge_version[DECK_STR_BRIDGE];
    int schema_version;
    int last_schema_version;
    uint32_t refresh_count;

    uint8_t row_count;       /**< 0 .. DECK_MAX_ROWS */
    uint16_t sessions_total; /**< pre-truncation total; enables +N */

    /** Full-fleet counts (from state_counts when present, else derived from rows). */
    uint16_t count_error;
    uint16_t count_waiting; /**< waiting + unknown for question tally */
    uint16_t count_done;
    uint16_t count_running;

    DeckSessionRow rows[DECK_MAX_ROWS];
} DeckView;
