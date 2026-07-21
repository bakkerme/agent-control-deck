/**
 * StatusSnapshot v1 parser (ArduinoJson 7).
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

uint16_t clamp_u16(int v)
{
    if (v < 0) {
        return 0;
    }
    if (v > 65535) {
        return 65535;
    }
    return (uint16_t)v;
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
        view->sessions_total = clamp_u16(doc["sessions_total"].as<int>());
    } else {
        view->sessions_total = clamp_u16((int)n_all);
    }

    /* Optional full-fleet state_counts; fall back to visible rows after parse. */
    bool have_counts = false;
    view->count_error = 0;
    view->count_waiting = 0;
    view->count_done = 0;
    view->count_running = 0;
    JsonObjectConst sc = doc["state_counts"].as<JsonObjectConst>();
    if (!sc.isNull()) {
        have_counts = true;
        if (sc["error"].is<int>()) {
            view->count_error = clamp_u16(sc["error"].as<int>());
        }
        int waiting = sc["waiting"].is<int>() ? sc["waiting"].as<int>() : 0;
        int unknown = sc["unknown"].is<int>() ? sc["unknown"].as<int>() : 0;
        view->count_waiting = clamp_u16(waiting + unknown);
        if (sc["done"].is<int>()) {
            view->count_done = clamp_u16(sc["done"].as<int>());
        }
        if (sc["running"].is<int>()) {
            view->count_running = clamp_u16(sc["running"].as<int>());
        }
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
        /* Prefer error text as body when present and state is error. */
        if (row->state == DECK_STATE_ERROR && row->error[0] &&
            (!row->summary[0] || strcmp(row->summary, row->error) != 0)) {
            /* Keep summary if already useful; error drawn as summary in UI. */
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

    if (!have_counts) {
        for (uint8_t i = 0; i < view->row_count; i++) {
            switch (view->rows[i].state) {
            case DECK_STATE_ERROR:
                view->count_error++;
                break;
            case DECK_STATE_WAITING:
            case DECK_STATE_UNKNOWN:
                view->count_waiting++;
                break;
            case DECK_STATE_DONE:
                view->count_done++;
                break;
            case DECK_STATE_RUNNING:
                view->count_running++;
                break;
            default:
                break;
            }
        }
    }

    return STATUS_PARSE_OK;
}
