/**
 * Minimal StatusSnapshot v1 parser (ArduinoJson 7).
 * Never logs body text.
 */

#include "status_parse.h"

#include <ArduinoJson.h>
#include <string.h>

namespace {

void copy_trunc(char *dst, size_t dst_len, const char *src)
{
    if (!dst || dst_len == 0) {
        return;
    }
    dst[0] = '\0';
    if (!src) {
        return;
    }
    strncpy(dst, src, dst_len - 1);
    dst[dst_len - 1] = '\0';
}

DeckSessionState parse_state(const char *s)
{
    if (!s) {
        return DECK_STATE_UNKNOWN;
    }
    if (strcmp(s, "running") == 0) {
        return DECK_STATE_RUNNING;
    }
    if (strcmp(s, "idle") == 0) {
        return DECK_STATE_IDLE;
    }
    if (strcmp(s, "waiting") == 0) {
        return DECK_STATE_WAITING;
    }
    if (strcmp(s, "error") == 0) {
        return DECK_STATE_ERROR;
    }
    if (strcmp(s, "done") == 0) {
        return DECK_STATE_DONE;
    }
    return DECK_STATE_UNKNOWN;
}

} // namespace

StatusParseResult status_parse_snapshot(const uint8_t *data, size_t len, DeckView *view)
{
    if (!view || !data || len == 0) {
        return STATUS_PARSE_ERROR;
    }

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, data, len);
    if (err) {
        return STATUS_PARSE_ERROR;
    }

    if (!doc["schema_version"].is<int>()) {
        return STATUS_PARSE_ERROR;
    }
    const int schema = doc["schema_version"].as<int>();
    view->last_schema_version = schema;
    if (schema != 1) {
        return STATUS_PARSE_SCHEMA;
    }

    JsonObjectConst host = doc["host"].as<JsonObjectConst>();
    if (host.isNull()) {
        return STATUS_PARSE_ERROR;
    }
    const char *host_name = host["name"].as<const char *>();
    const char *bridge_ver = host["bridge_version"].as<const char *>();
    if (!host_name || !bridge_ver) {
        return STATUS_PARSE_ERROR;
    }

    JsonArrayConst sessions = doc["sessions"].as<JsonArrayConst>();
    if (sessions.isNull()) {
        return STATUS_PARSE_ERROR;
    }

    copy_trunc(view->host_name, sizeof(view->host_name), host_name);
    copy_trunc(view->bridge_version, sizeof(view->bridge_version), bridge_ver);
    view->schema_version = 1;

    const size_t n_all = sessions.size();
    if (doc["sessions_total"].is<int>()) {
        int st = doc["sessions_total"].as<int>();
        if (st < 0) {
            st = 0;
        }
        if (st > 65535) {
            st = 65535;
        }
        view->sessions_total = (uint16_t)st;
    } else {
        view->sessions_total = (uint16_t)(n_all > 65535 ? 65535 : n_all);
    }

    view->row_count = 0;
    memset(view->rows, 0, sizeof(view->rows));

    for (JsonObjectConst s : sessions) {
        if (view->row_count >= DECK_MAX_ROWS) {
            break;
        }
        DeckSessionRow *row = &view->rows[view->row_count];
        const char *agent = s["agent"].as<const char *>();
        const char *title = s["title"].as<const char *>();
        const char *summary = s["summary"].as<const char *>();
        const char *state = s["state"].as<const char *>();
        if (!agent || !title || !summary || !state) {
            /* Skip incomplete row rather than fail whole snapshot for spike. */
            continue;
        }
        row->state = parse_state(state);
        copy_trunc(row->agent, sizeof(row->agent), agent);
        copy_trunc(row->title, sizeof(row->title), title);
        copy_trunc(row->summary, sizeof(row->summary), summary);
        const char *detail = s["detail"].as<const char *>();
        if (detail) {
            copy_trunc(row->detail, sizeof(row->detail), detail);
        }
        const char *error = s["error"].as<const char *>();
        if (error) {
            copy_trunc(row->error, sizeof(row->error), error);
        }
        if (s["progress"].is<float>() || s["progress"].is<double>() || s["progress"].is<int>()) {
            row->has_progress = true;
            row->progress = s["progress"].as<float>();
        } else {
            row->has_progress = false;
            row->progress = 0.0f;
        }
        view->row_count++;
    }

    return STATUS_PARSE_OK;
}
