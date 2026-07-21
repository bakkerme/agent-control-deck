/**
 * Design C · 8 agents @ ~18px — e-paper status board (960×540).
 *
 * Single top bar (state counts + link age + optional +N), session rows:
 *   icon | path (title) | summary
 * No footer, no progress bars.
 *
 * Type: FiraSansUI (9pt @ 150dpi → ~18px ascender / ~23px line) to match
 * designs/design.png density so full design summaries fit on-glass.
 * Icons: ~30px row glyphs (design C), thickened for e-paper contrast.
 * Density: fixed 8-slot row grid — do not stretch when fewer sessions show.
 */

#include "ui_layout.h"

#include <stdio.h>
#include <string.h>

#include "epd_driver.h"
#include "firasans_ui.h"

/* Layout constants (panel 960×540; designs/epaper-status-board.html · C). */
static const int32_t kMarginX = 16;
static const int32_t kTopbarH = 46;
static const int32_t kStaleBannerH = 28;
static const int32_t kIconColW = 46;  /* room for ~30px icons */
static const int32_t kPathColW = 250; /* fits ~/src/frontend/components @ 18px */
static const int32_t kColGap = 12;
static const int32_t kIconR = 15;     /* 30px diameter — design C */
static const int32_t kMiniIconR = 8;  /* 16px — design C top-bar */
static const int32_t kColorBlack = 0;
static const int32_t kColorWhite = 0xFF;

static const GFXfont *ui_font(void)
{
    return (const GFXfont *)&FiraSansUI;
}

/** Pixel width of @p text (0 if empty). */
static int32_t text_width(const char *text)
{
    if (!text || !text[0]) {
        return 0;
    }
    int32_t x = 0;
    int32_t y = 0;
    int32_t x1 = 0;
    int32_t y1 = 0;
    int32_t w = 0;
    int32_t h = 0;
    get_text_bounds(ui_font(), text, &x, &y, &x1, &y1, &w, &h, NULL);
    return w > 0 ? w : 0;
}

static void draw_text(uint8_t *fb, int32_t x, int32_t y, const char *text)
{
    if (!text || !text[0]) {
        return;
    }
    int32_t cx = x;
    int32_t cy = y;
    writeln(ui_font(), text, &cx, &cy, fb);
}

static void draw_hline(uint8_t *fb, int32_t y)
{
    epd_draw_line(kMarginX, y, EPD_WIDTH - kMarginX, y, kColorBlack, fb);
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

/**
 * Truncate s into out so measured pixel width ≤ max_px.
 * End-ellipsis ("head...") — matches design.png path column (keep ~/src/…).
 */
static void trunc_fit(char *out, size_t out_len, const char *s, int32_t max_px)
{
    if (!out || out_len == 0) {
        return;
    }
    out[0] = '\0';
    if (!s || !s[0] || max_px <= 0) {
        return;
    }

    if (text_width(s) <= max_px) {
        strncpy(out, s, out_len - 1);
        out[out_len - 1] = '\0';
        return;
    }

    const size_t n = strlen(s);
    /* Longest prefix such that prefix + "..." fits. */
    size_t lo = 1;
    size_t hi = n;
    size_t best = 1;
    while (lo <= hi) {
        size_t mid = (lo + hi) / 2;
        if (mid + 4 > out_len) {
            if (mid == 0) {
                break;
            }
            hi = mid - 1;
            continue;
        }
        /* Build candidate: first mid chars + "..." */
        if (mid >= out_len) {
            hi = mid - 1;
            continue;
        }
        memcpy(out, s, mid);
        out[mid] = '\0';
        strncat(out, "...", out_len - mid - 1);
        if (text_width(out) <= max_px) {
            best = mid;
            lo = mid + 1;
        } else {
            if (mid == 0) {
                break;
            }
            hi = mid - 1;
        }
    }
    if (best + 4 > out_len) {
        best = out_len > 4 ? out_len - 4 : 1;
    }
    memcpy(out, s, best);
    out[best] = '\0';
    strncat(out, "...", out_len - best - 1);
}

/* ---- Thick primitives (e-paper single-pixel strokes vanish at desk distance) ---- */

static void thick_circle(uint8_t *fb, int32_t cx, int32_t cy, int32_t r)
{
    epd_draw_circle(cx, cy, r, kColorBlack, fb);
    if (r > 2) {
        epd_draw_circle(cx, cy, r - 1, kColorBlack, fb);
    }
    if (r > 6) {
        epd_draw_circle(cx, cy, r - 2, kColorBlack, fb);
    }
}

static void thick_line(uint8_t *fb, int32_t x0, int32_t y0, int32_t x1, int32_t y1)
{
    epd_draw_line(x0, y0, x1, y1, kColorBlack, fb);
    epd_draw_line(x0 + 1, y0, x1 + 1, y1, kColorBlack, fb);
    epd_draw_line(x0, y0 + 1, x1, y1 + 1, kColorBlack, fb);
}

static void thick_line_white(uint8_t *fb, int32_t x0, int32_t y0, int32_t x1, int32_t y1)
{
    epd_draw_line(x0, y0, x1, y1, kColorWhite, fb);
    epd_draw_line(x0 + 1, y0, x1 + 1, y1, kColorWhite, fb);
    epd_draw_line(x0, y0 + 1, x1, y1 + 1, kColorWhite, fb);
    epd_draw_line(x0 - 1, y0, x1 - 1, y1, kColorWhite, fb);
}

/* ---- State icons (design C glyphs, ~30px) ---- */

static void icon_failed(uint8_t *fb, int32_t cx, int32_t cy, int32_t r)
{
    thick_circle(fb, cx, cy, r);
    const int32_t d = (r * 5) / 10;
    thick_line(fb, cx - d, cy - d, cx + d, cy + d);
    thick_line(fb, cx + d, cy - d, cx - d, cy + d);
}

static void icon_question(uint8_t *fb, int32_t cx, int32_t cy, int32_t r)
{
    thick_circle(fb, cx, cy, r);
    /* Geometric "?": arc + stem + dot (no font dependency). */
    const int32_t s = (r * 4) / 10;
    if (s < 2) {
        return;
    }
    thick_circle(fb, cx, cy - s / 2, s);
    /* Open bottom of the small circle. */
    for (int32_t dy = 0; dy < 3; dy++) {
        for (int32_t dx = -s; dx <= s; dx++) {
            epd_draw_pixel(cx + dx, cy - s / 2 + s - dy, kColorWhite, fb);
        }
    }
    thick_line(fb, cx, cy - s / 2 + s - 1, cx, cy + s / 2);
    const int32_t ds = r >= 10 ? 3 : 2;
    epd_fill_rect(cx - ds / 2, cy + s + 1, ds, ds, kColorBlack, fb);
}

static void icon_done(uint8_t *fb, int32_t cx, int32_t cy, int32_t r)
{
    epd_fill_circle(cx, cy, r, kColorBlack, fb);
    const int32_t x0 = cx - (r * 5) / 10;
    const int32_t y0 = cy;
    const int32_t x1 = cx - r / 10;
    const int32_t y1 = cy + (r * 5) / 10;
    const int32_t x2 = cx + (r * 5) / 10;
    const int32_t y2 = cy - (r * 4) / 10;
    thick_line_white(fb, x0, y0, x1, y1);
    thick_line_white(fb, x1, y1, x2, y2);
}

static void icon_working(uint8_t *fb, int32_t cx, int32_t cy, int32_t r)
{
    /* Static spinner: thick ring with a gap in the upper-right. */
    thick_circle(fb, cx, cy, r);
    const int32_t gap = (r * 6) / 10;
    for (int32_t dy = -r; dy <= 0; dy++) {
        for (int32_t dx = 0; dx <= r; dx++) {
            const int32_t d2 = dx * dx + dy * dy;
            if (d2 <= r * r && d2 >= (r - 4) * (r - 4)) {
                if (dx + dy > gap / 2) {
                    epd_draw_pixel(cx + dx, cy + dy, kColorWhite, fb);
                }
            }
        }
    }
}

static void icon_idle(uint8_t *fb, int32_t cx, int32_t cy, int32_t r)
{
    thick_circle(fb, cx, cy, r);
}

static void draw_state_icon_at(uint8_t *fb, DeckSessionState st, int32_t cx, int32_t cy,
                               int32_t r)
{
    switch (st) {
    case DECK_STATE_ERROR:
        icon_failed(fb, cx, cy, r);
        break;
    case DECK_STATE_WAITING:
    case DECK_STATE_UNKNOWN:
        icon_question(fb, cx, cy, r);
        break;
    case DECK_STATE_DONE:
        icon_done(fb, cx, cy, r);
        break;
    case DECK_STATE_RUNNING:
        icon_working(fb, cx, cy, r);
        break;
    case DECK_STATE_IDLE:
    default:
        icon_idle(fb, cx, cy, r);
        break;
    }
}

static void draw_state_icon(uint8_t *fb, DeckSessionState st, int32_t cx, int32_t cy)
{
    draw_state_icon_at(fb, st, cx, cy, kIconR);
}

/** Mini icon + digit for top-bar counts (~16px). */
static void draw_mini_count(uint8_t *fb, int32_t *x, int32_t baseline_y, DeckSessionState st,
                            int count)
{
    const int32_t r = kMiniIconR;
    const int32_t cx = *x + r;
    /* Center mini glyph on the text cap-height band. */
    const int32_t cy = baseline_y - (ui_font()->ascender / 3);
    draw_state_icon_at(fb, st, cx, cy, r);
    *x += 2 * r + 5;
    char buf[8];
    snprintf(buf, sizeof(buf), "%d", count);
    draw_text(fb, *x, baseline_y, buf);
    *x += text_width(buf) + 12;
}

static void draw_topbar(uint8_t *fb, const DeckView *view)
{
    const GFXfont *font = ui_font();
    /*
     * Vertically center the glyph band in the top bar.
     * baseline ≈ top + (bar + ascender + descender) / 2
     */
    int32_t baseline = (kTopbarH + font->ascender + font->descender) / 2 + 6;
    if (baseline < 26) {
        baseline = 26;
    }
    if (baseline > 38) {
        baseline = 38;
    }

    int32_t x = kMarginX;
    draw_mini_count(fb, &x, baseline, DECK_STATE_ERROR, (int)view->count_error);
    draw_mini_count(fb, &x, baseline, DECK_STATE_WAITING, (int)view->count_waiting);
    draw_mini_count(fb, &x, baseline, DECK_STATE_DONE, (int)view->count_done);
    draw_mini_count(fb, &x, baseline, DECK_STATE_RUNNING, (int)view->count_running);

    char age_buf[12];
    format_age(view->age_ms, age_buf, sizeof(age_buf));

    const char *link_tok = "*";
    if (view->link_state == DECK_LINK_DEGRADED) {
        link_tok = "!";
    } else if (view->link_state == DECK_LINK_DOWN || view->stale) {
        link_tok = "o";
    }

    char transport[DECK_STR_TRANSPORT];
    if (view->transport[0]) {
        size_t i = 0;
        for (; view->transport[i] && i + 1 < sizeof(transport); i++) {
            char c = view->transport[i];
            if (c >= 'a' && c <= 'z') {
                c = (char)(c - 'a' + 'A');
            }
            transport[i] = c;
        }
        transport[i] = '\0';
    } else {
        strncpy(transport, "BLE", sizeof(transport) - 1);
        transport[sizeof(transport) - 1] = '\0';
    }

    int more = 0;
    if (view->sessions_total > view->row_count) {
        more = (int)view->sessions_total - (int)view->row_count;
    }

    /* Design mock: "BLE * 12s · +2" */
    char right[40];
    if (more > 0) {
        snprintf(right, sizeof(right), "%s %s  %s  +%d", transport, link_tok, age_buf, more);
    } else {
        snprintf(right, sizeof(right), "%s %s  %s", transport, link_tok, age_buf);
    }

    int32_t tw = text_width(right);
    int32_t rx = EPD_WIDTH - kMarginX - tw;
    if (rx < x + 12) {
        if (more > 0) {
            snprintf(right, sizeof(right), "%s %s +%d", transport, link_tok, more);
        } else {
            snprintf(right, sizeof(right), "%s %s", transport, link_tok);
        }
        tw = text_width(right);
        rx = EPD_WIDTH - kMarginX - tw;
    }
    if (rx < x + 8) {
        rx = x + 8;
    }
    draw_text(fb, rx, baseline, right);

    draw_hline(fb, kTopbarH);
    epd_draw_line(kMarginX, kTopbarH + 1, EPD_WIDTH - kMarginX, kTopbarH + 1, kColorBlack, fb);
}

static int32_t draw_stale_banner(uint8_t *fb, const DeckView *view)
{
    char age_buf[12];
    format_age(view->age_ms, age_buf, sizeof(age_buf));

    char line[80];
    snprintf(line, sizeof(line), "STALE · last ok %s ago · cached", age_buf);

    const GFXfont *font = ui_font();
    const int32_t y = kTopbarH + font->advance_y + font->descender - 2;
    draw_text(fb, kMarginX + 4, y, line);
    draw_hline(fb, kTopbarH + kStaleBannerH);
    return kStaleBannerH;
}

static void draw_centered_block(uint8_t *fb, const char *line1, const char *line2,
                                const char *line3)
{
    const GFXfont *font = ui_font();
    const int32_t line_gap = font->advance_y;
    int32_t mid_y = EPD_HEIGHT / 2 - line_gap;
    int32_t left = kMarginX + 40;

    if (line1) {
        draw_text(fb, left, mid_y, line1);
    }
    if (line2) {
        draw_text(fb, left, mid_y + line_gap, line2);
    }
    if (line3) {
        draw_text(fb, left, mid_y + 2 * line_gap, line3);
    }
}

static void draw_session_row(uint8_t *fb, const DeckSessionRow *row, int32_t row_top,
                             int32_t row_h, bool draw_separator)
{
    const GFXfont *font = ui_font();
    const int32_t mid_y = row_top + row_h / 2;
    /* Center glyph band in the row (ascender above baseline, descender below). */
    const int32_t text_y = mid_y + (font->ascender + font->descender) / 2;

    const int32_t icon_cx = kMarginX + kIconColW / 2;
    draw_state_icon(fb, row->state, icon_cx, mid_y);

    const int32_t path_x = kMarginX + kIconColW + kColGap;
    char path_buf[DECK_STR_TITLE];
    trunc_fit(path_buf, sizeof(path_buf), row->title[0] ? row->title : "?", kPathColW);
    draw_text(fb, path_x, text_y, path_buf);

    const int32_t sum_x = path_x + kPathColW + kColGap;
    const int32_t sum_max_w = EPD_WIDTH - kMarginX - sum_x;
    const char *body = row->summary;
    if (row->state == DECK_STATE_ERROR && row->error[0]) {
        body = row->error;
    }
    char sum_buf[DECK_STR_SUMMARY];
    trunc_fit(sum_buf, sizeof(sum_buf), body && body[0] ? body : "-", sum_max_w);
    draw_text(fb, sum_x, text_y, sum_buf);

    if (draw_separator) {
        draw_hline(fb, row_top + row_h);
    }
}

static void draw_empty_body(uint8_t *fb, const DeckView *view, int32_t body_top)
{
    (void)body_top;
    if (view->stale || view->link_state == DECK_LINK_DOWN) {
        char age_buf[12];
        format_age(view->age_ms, age_buf, sizeof(age_buf));
        char line2[64];
        snprintf(line2, sizeof(line2), "Last ok %s ago", age_buf);
        draw_centered_block(fb, "NO LINK", line2, "No cached sessions");
        return;
    }
    if (view->link_state == DECK_LINK_DEGRADED) {
        draw_centered_block(fb, "No agent sessions", "Link degraded · waiting", NULL);
        return;
    }
    draw_centered_block(fb, "No agent sessions", "Bridge OK · waiting for adapters", NULL);
}

static void draw_schema_frame(uint8_t *fb, const DeckView *view)
{
    char detail[80];
    int got = view->last_schema_version;
    snprintf(detail, sizeof(detail), "Unsupported schema_version (got %d, need 1)", got);

    draw_topbar(fb, view);
    draw_centered_block(fb, "SCHEMA", detail, "Update bridge or firmware");
}

static void draw_stale_empty_frame(uint8_t *fb, const DeckView *view)
{
    char age_buf[12];
    format_age(view->age_ms, age_buf, sizeof(age_buf));

    char line2[96];
    snprintf(line2, sizeof(line2), "Last ok %s ago", age_buf);

    draw_topbar(fb, view);
    draw_centered_block(fb, "NO LINK", line2, "No cached sessions");
}

static void draw_normal(uint8_t *fb, const DeckView *view)
{
    draw_topbar(fb, view);

    int32_t body_top = kTopbarH;
    const int32_t body_bottom = EPD_HEIGHT;

    const bool stale_with_rows = view->stale && view->row_count > 0;
    if (stale_with_rows) {
        body_top += draw_stale_banner(fb, view);
    }

    const int32_t body_h = body_bottom - body_top;

    uint8_t n = view->row_count;
    if (n > DECK_MAX_ROWS) {
        n = DECK_MAX_ROWS;
    }

    if (n == 0) {
        draw_empty_body(fb, view, body_top);
        return;
    }

    /* Fixed 8-slot grid so density matches design.png even with fewer sessions. */
    const int32_t row_h = body_h / (int32_t)DECK_MAX_ROWS;
    for (uint8_t i = 0; i < n; i++) {
        const bool is_last = (i + 1 == n);
        const bool draw_sep = !is_last || (int)n < DECK_MAX_ROWS;
        draw_session_row(fb, &view->rows[i], body_top + (int32_t)i * row_h, row_h, draw_sep);
    }
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

    if (view->stale && view->row_count == 0) {
        draw_stale_empty_frame(framebuffer, view);
        return;
    }

    draw_normal(framebuffer, view);
}
