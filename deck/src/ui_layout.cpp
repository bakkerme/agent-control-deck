/**
 * Multi-session status layout for 960×540 e-paper.
 *
 * ASCII state tokens + geometric progress bars. No networking.
 */

#include "ui_layout.h"

#include <stdio.h>
#include <string.h>

#include "epd_driver.h"
#include "firasans.h"

/* Layout constants (panel 960×540, margins ~22 px). */
static const int32_t kMarginX = 22;
static const int32_t kMarginY = 18;
static const int32_t kHeaderH = 48;
static const int32_t kFooterH = 36;
static const int32_t kLineAdvance = 42; /* FiraSans advance_y is 50; tighter for rows */
static const int32_t kColorBlack = 0;
static const int32_t kColorWhite = 0xFF;

static const char *state_token(DeckSessionState s)
{
    switch (s) {
    case DECK_STATE_RUNNING:
        return "*";
    case DECK_STATE_IDLE:
        return "o";
    case DECK_STATE_WAITING:
        return "...";
    case DECK_STATE_ERROR:
        return "!";
    case DECK_STATE_DONE:
        return "v";
    case DECK_STATE_UNKNOWN:
    default:
        return "?";
    }
}

static const char *state_label(DeckSessionState s)
{
    switch (s) {
    case DECK_STATE_RUNNING:
        return "RUNNING";
    case DECK_STATE_IDLE:
        return "IDLE";
    case DECK_STATE_WAITING:
        return "WAITING";
    case DECK_STATE_ERROR:
        return "ERROR";
    case DECK_STATE_DONE:
        return "DONE";
    case DECK_STATE_UNKNOWN:
    default:
        return "UNKNOWN";
    }
}

/** Coarse relative age: "0s", "12s", "3m", "2h". */
static void format_age(uint32_t age_ms, char *out, size_t out_len)
{
    if (out_len == 0) {
        return;
    }
    uint32_t sec = age_ms / 1000u;
    if (sec < 60u) {
        snprintf(out, out_len, "%lus", (unsigned long)sec);
    } else if (sec < 3600u) {
        snprintf(out, out_len, "%lum", (unsigned long)(sec / 60u));
    } else {
        snprintf(out, out_len, "%luh", (unsigned long)(sec / 3600u));
    }
}

static void draw_text(uint8_t *fb, int32_t x, int32_t y, const char *text)
{
    if (!text || !text[0]) {
        return;
    }
    int32_t cx = x;
    int32_t cy = y;
    writeln((GFXfont *)&FiraSans, text, &cx, &cy, fb);
}

static void draw_hline(uint8_t *fb, int32_t y)
{
    epd_draw_line(kMarginX, y, EPD_WIDTH - kMarginX, y, kColorBlack, fb);
}

static void draw_progress_bar(uint8_t *fb, int32_t x, int32_t y, int32_t w, int32_t h,
                              float progress)
{
    if (w < 4 || h < 4) {
        return;
    }
    if (progress < 0.0f) {
        progress = 0.0f;
    }
    if (progress > 1.0f) {
        progress = 1.0f;
    }

    epd_draw_rect(x, y, w, h, kColorBlack, fb);

    int32_t inner_w = w - 4;
    int32_t fill_w = (int32_t)((float)inner_w * progress + 0.5f);
    if (fill_w > 0) {
        epd_fill_rect(x + 2, y + 2, fill_w, h - 4, kColorBlack, fb);
    }
}

static void draw_centered_block(uint8_t *fb, const char *line1, const char *line2,
                                const char *line3)
{
    /* Approximate center: FiraSans is ~ mono-width enough for short labels. */
    int32_t mid_y = EPD_HEIGHT / 2 - 40;
    int32_t left = kMarginX + 40;

    if (line1) {
        draw_text(fb, left, mid_y, line1);
    }
    if (line2) {
        draw_text(fb, left, mid_y + kLineAdvance, line2);
    }
    if (line3) {
        draw_text(fb, left, mid_y + 2 * kLineAdvance, line3);
    }
}

static void draw_header(uint8_t *fb, const DeckView *view)
{
    const int32_t base_y = kMarginY + 30;

    draw_text(fb, kMarginX, base_y, "AGENT CONTROL DECK");

    char age_buf[12];
    format_age(view->age_ms, age_buf, sizeof(age_buf));

    const char *link_tok = "*";
    if (view->link_state == DECK_LINK_DEGRADED) {
        link_tok = "!";
    } else if (view->link_state == DECK_LINK_DOWN || view->stale) {
        link_tok = "o";
    }

    const char *transport =
        view->transport[0] ? view->transport : "demo";

    char right[64];
    /* e.g. "demo *  12s  bat --%" — transport label stands in for WiFi in demo */
    snprintf(right, sizeof(right), "%s %s  %s  bat --%%", transport, link_tok, age_buf);

    /* Right-align approximately: ~11 px/char for FiraSans uppercase-ish. */
    int32_t approx_w = (int32_t)strlen(right) * 14;
    int32_t rx = EPD_WIDTH - kMarginX - approx_w;
    if (rx < EPD_WIDTH / 2) {
        rx = EPD_WIDTH / 2;
    }
    draw_text(fb, rx, base_y, right);

    draw_hline(fb, kMarginY + kHeaderH);
}

static void draw_footer(uint8_t *fb, const DeckView *view)
{
    const int32_t footer_top = EPD_HEIGHT - kMarginY - kFooterH;
    draw_hline(fb, footer_top);

    const int32_t base_y = footer_top + 28;
    char line[160];
    const char *host = view->host_name[0] ? view->host_name : "-";
    const char *bridge = view->bridge_version[0] ? view->bridge_version : "-";
    int schema = view->schema_version > 0 ? view->schema_version : 1;

    int more = 0;
    if (view->sessions_total > DECK_MAX_ROWS) {
        more = (int)view->sessions_total - DECK_MAX_ROWS;
    }

    if (more > 0) {
        snprintf(line, sizeof(line),
                 "host:%s   bridge %s   schema v%d   refresh #%lu   +%d more", host, bridge,
                 schema, (unsigned long)view->refresh_count, more);
    } else {
        snprintf(line, sizeof(line), "host:%s   bridge %s   schema v%d   refresh #%lu",
                 host, bridge, schema, (unsigned long)view->refresh_count);
    }

    draw_text(fb, kMarginX, base_y, line);
}

static void draw_empty_body(uint8_t *fb, const DeckView *view)
{
    (void)view;
    draw_centered_block(fb, "No agent sessions", "Bridge OK · waiting for adapters", NULL);
}

static void draw_schema_frame(uint8_t *fb, const DeckView *view)
{
    char detail[80];
    int got = view->last_schema_version;
    snprintf(detail, sizeof(detail), "Unsupported schema_version (got %d, need 1)", got);

    draw_header(fb, view);
    draw_centered_block(fb, "SCHEMA", detail, "Update bridge or firmware");
    draw_footer(fb, view);
}

static void draw_stale_frame(uint8_t *fb, const DeckView *view)
{
    char age_buf[12];
    format_age(view->age_ms, age_buf, sizeof(age_buf));

    char line2[96];
    snprintf(line2, sizeof(line2), "Last ok %s ago", age_buf);

    draw_header(fb, view);
    draw_centered_block(fb, "NO LINK", line2, "Showing cached snapshot (STALE)");
    draw_footer(fb, view);
}

static void draw_session_row(uint8_t *fb, const DeckSessionRow *row, int32_t row_top,
                             int32_t row_h)
{
    const int32_t pad = 10;
    const int32_t text_x = kMarginX + pad;
    int32_t y = row_top + 36;

    /* Line 1: token STATE   agent · title */
    char line1[96];
    snprintf(line1, sizeof(line1), "%s %-8s  %s · %s", state_token(row->state),
             state_label(row->state), row->agent[0] ? row->agent : "?",
             row->title[0] ? row->title : "-");
    draw_text(fb, text_x, y, line1);

    /* Line 2: summary, or error text when in error state */
    y += kLineAdvance;
    const char *body = row->summary;
    if (row->state == DECK_STATE_ERROR && row->error[0]) {
        body = row->error;
    }
    if (body && body[0]) {
        draw_text(fb, text_x, y, body);
    }

    /* Line 3: optional progress bar + detail */
    y += kLineAdvance - 4;
    if (row->has_progress) {
        const int32_t bar_w = 220;
        const int32_t bar_h = 18;
        draw_progress_bar(fb, text_x, y - 14, bar_w, bar_h, row->progress);

        char pct[48];
        int p = (int)(row->progress * 100.0f + 0.5f);
        if (row->detail[0]) {
            snprintf(pct, sizeof(pct), "%d%%   %s", p, row->detail);
        } else {
            snprintf(pct, sizeof(pct), "%d%%", p);
        }
        draw_text(fb, text_x + bar_w + 16, y, pct);
    } else if (row->detail[0]) {
        draw_text(fb, text_x, y, row->detail);
    }

    /* Row separator */
    draw_hline(fb, row_top + row_h);
}

static void draw_normal(uint8_t *fb, const DeckView *view)
{
    draw_header(fb, view);

    const int32_t body_top = kMarginY + kHeaderH;
    const int32_t body_bottom = EPD_HEIGHT - kMarginY - kFooterH;
    const int32_t body_h = body_bottom - body_top;

    uint8_t n = view->row_count;
    if (n > DECK_MAX_ROWS) {
        n = DECK_MAX_ROWS;
    }

    if (n == 0) {
        draw_empty_body(fb, view);
    } else {
        int32_t row_h = body_h / (int32_t)n;
        /* Cap row height so 1–2 rows don't look absurdly tall. */
        if (row_h > 130) {
            row_h = 130;
        }
        for (uint8_t i = 0; i < n; i++) {
            draw_session_row(fb, &view->rows[i], body_top + (int32_t)i * row_h, row_h);
        }
        /* Ensure bottom separator before footer when row height was capped. */
        if ((int32_t)n * row_h < body_h) {
            draw_hline(fb, body_top + (int32_t)n * row_h);
        }
    }

    draw_footer(fb, view);
}

void ui_draw_status(uint8_t *framebuffer, const DeckView *view)
{
    if (!framebuffer || !view) {
        return;
    }

    memset(framebuffer, kColorWhite, (size_t)EPD_WIDTH * (size_t)EPD_HEIGHT / 2);

    if (view->fault == DECK_FAULT_SCHEMA) {
        draw_schema_frame(framebuffer, view);
        return;
    }

    /* Full-screen STALE only when no rows to show (cached empty). Normal
     * layout still draws when we have cached sessions; header link token
     * reflects degraded/down. */
    if (view->stale && view->row_count == 0 &&
        (view->link_state == DECK_LINK_DOWN || view->link_state == DECK_LINK_DEGRADED)) {
        draw_stale_frame(framebuffer, view);
        return;
    }

    draw_normal(framebuffer, view);
}
