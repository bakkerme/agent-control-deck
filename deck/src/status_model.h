/**
 * Device-local view model for the e-paper status layout.
 *
 * C structs only — no ArduinoJson / parse path here (see later PRs).
 * Firmware maps a StatusSnapshot (or a compile-time fixture) into DeckView.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

/** Hard cap matching bridge display_limit / on-glass row count. */
#define DECK_MAX_ROWS 3

/** Fixed buffer sizes (include trailing NUL); match schema truncation guidance. */
#define DECK_STR_AGENT 25
#define DECK_STR_TITLE 25
#define DECK_STR_SUMMARY 81
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
    char title[DECK_STR_TITLE];
    char summary[DECK_STR_SUMMARY];
    char detail[DECK_STR_DETAIL];
    char error[DECK_STR_ERROR];
    bool has_progress; /**< true → draw geometric bar from progress */
    float progress;    /**< 0.0 .. 1.0 when has_progress */
} DeckSessionRow;

/**
 * Full-screen view model. Frame priority (highest wins):
 *   1. fault == SCHEMA → schema fault frame
 *   2. stale / link down with no usable rows → NO LINK / empty
 *   3. normal header + 0–3 rows + footer (empty body if row_count == 0)
 */
typedef struct {
    DeckLinkState link_state;
    bool stale;
    DeckFault fault;
    uint32_t age_ms; /**< relative age of last good snapshot (device millis) */

    char transport[DECK_STR_TRANSPORT]; /**< device-local: "demo", "usb", "wifi", ... */
    char host_name[DECK_STR_HOST];
    char bridge_version[DECK_STR_BRIDGE];
    int schema_version;     /**< expected / last good, typically 1 */
    int last_schema_version; /**< from last body, for SCHEMA message */
    uint32_t refresh_count;  /**< footer refresh counter */

    uint8_t row_count;        /**< 0 .. DECK_MAX_ROWS */
    uint16_t sessions_total;  /**< pre-truncation total; enables footer +N more */
    DeckSessionRow rows[DECK_MAX_ROWS];
} DeckView;
