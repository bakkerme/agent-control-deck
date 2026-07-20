/**
 * StatusSnapshot JSON → DeckView content (S3).
 *
 * Does not set link_state / stale / fault / age_ms / transport — caller owns
 * Outcome A/B/C policy.
 */

#pragma once

#include <stddef.h>
#include <stdint.h>

#include "status_model.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    STATUS_PARSE_OK = 0,     /**< schema_version == 1 and JSON usable */
    STATUS_PARSE_SCHEMA,     /**< JSON had schema_version but != 1 */
    STATUS_PARSE_ERROR,      /**< empty, invalid JSON, missing required fields */
} StatusParseResult;

/**
 * Parse a StatusSnapshot body into @p view session/host fields.
 * On STATUS_PARSE_OK: fills host_name, bridge_version, schema fields, rows,
 * sessions_total; leaves link/stale/fault/age/transport/refresh_count alone
 * (except last_schema_version / schema_version).
 * On STATUS_PARSE_SCHEMA: sets last_schema_version; does not touch rows.
 * On STATUS_PARSE_ERROR: leaves view content unchanged.
 */
StatusParseResult status_parse_snapshot(const uint8_t *data, size_t len, DeckView *view);

#ifdef __cplusplus
}
#endif
