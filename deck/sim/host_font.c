/**
 * Host font renderer for FiraSansUI / GFXfont.
 * Adapted from LilyGo-EPD47 src/font.c (GPL-3.0).
 *
 * Compressed glyphs are not supported in the host sim (FiraSansUI is uncompressed).
 */

#include "epd_driver.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    uint8_t mask;
    uint8_t lead;
    uint32_t beg;
    uint32_t end;
    int32_t bits_stored;
} utf_t;

static inline int32_t min_i32(int32_t x, int32_t y)
{
    return x < y ? x : y;
}

static inline int32_t max_i32(int32_t x, int32_t y)
{
    return x > y ? x : y;
}

static int32_t utf8_len(const uint8_t ch);
static uint32_t next_cp(uint8_t **string);
static FontProperties font_properties_default(void);
static void draw_char(const GFXfont *font, uint8_t *buffer, int32_t *cursor_x, int32_t cursor_y,
                      uint16_t buf_width, uint16_t buf_height, uint32_t cp,
                      const FontProperties *props);
static void get_char_bounds(const GFXfont *font, uint32_t cp, int32_t *x, int32_t *y, int32_t *minx,
                            int32_t *miny, int32_t *maxx, int32_t *maxy,
                            const FontProperties *props);

static utf_t *utf[] = {
    [0] = &(utf_t){0b00111111, 0b10000000, 0, 0, 6},
    [1] = &(utf_t){0b01111111, 0b00000000, 0000, 0177, 7},
    [2] = &(utf_t){0b00011111, 0b11000000, 0200, 03777, 5},
    [3] = &(utf_t){0b00001111, 0b11100000, 04000, 0177777, 4},
    [4] = &(utf_t){0b00000111, 0b11110000, 0200000, 04177777, 3},
    &(utf_t){0},
};

void get_glyph(const GFXfont *font, uint32_t code_point, GFXglyph **glyph)
{
    UnicodeInterval *intervals = font->intervals;
    *glyph = NULL;
    for (int32_t i = 0; i < (int32_t)font->interval_count; i++) {
        UnicodeInterval *interval = &intervals[i];
        if (code_point >= interval->first && code_point <= interval->last) {
            *glyph = &font->glyph[interval->offset + (code_point - interval->first)];
            return;
        }
        if (code_point < interval->first) {
            return;
        }
    }
}

void get_text_bounds(const GFXfont *font, const char *string, int32_t *x, int32_t *y, int32_t *x1,
                     int32_t *y1, int32_t *w, int32_t *h, const FontProperties *properties)
{
    FontProperties props;
    if (properties == NULL) {
        props = font_properties_default();
    } else {
        props = *properties;
    }

    if (*string == '\0') {
        *w = 0;
        *h = 0;
        *y1 = *y;
        *x1 = *x;
        return;
    }
    int32_t minx = 100000, miny = 100000, maxx = -1, maxy = -1;
    int32_t original_x = *x;
    uint32_t c;
    while ((c = next_cp((uint8_t **)&string))) {
        get_char_bounds(font, c, x, y, &minx, &miny, &maxx, &maxy, &props);
    }
    *x1 = min_i32(original_x, minx);
    *w = maxx - *x1;
    *y1 = miny;
    *h = maxy - miny;
}

void write_mode(const GFXfont *font, const char *string, int32_t *cursor_x, int32_t *cursor_y,
                uint8_t *framebuffer, DrawMode_t mode, const FontProperties *properties)
{
    (void)mode;
    if (*string == '\0') {
        return;
    }

    FontProperties props = (properties == NULL) ? font_properties_default() : *properties;

    int32_t x1 = 0, y1 = 0, w = 0, h = 0;
    int32_t tmp_cur_x = *cursor_x;
    int32_t tmp_cur_y = *cursor_y;
    get_text_bounds(font, string, &tmp_cur_x, &tmp_cur_y, &x1, &y1, &w, &h, &props);

    if (framebuffer == NULL) {
        /* Direct-to-panel path not used by host sim / ui_layout. */
        fprintf(stderr, "acd-ui-sim: writeln without framebuffer is unsupported\n");
        return;
    }

    int32_t buf_width = EPD_WIDTH / 2;
    int32_t buf_height = EPD_HEIGHT;
    uint8_t *buffer = framebuffer;
    int32_t local_cursor_x = *cursor_x;
    int32_t local_cursor_y = *cursor_y;
    int32_t baseline_height = *cursor_y - y1;

    int32_t cursor_x_init = local_cursor_x;
    int32_t cursor_y_init = local_cursor_y;

    uint8_t bg = props.bg_color;
    if (props.flags & DRAW_BACKGROUND) {
        for (int32_t l = 0; l < font->advance_y; l++) {
            epd_draw_hline(local_cursor_x,
                           local_cursor_y - (font->advance_y - baseline_height) + l, w, bg << 4,
                           buffer);
        }
    }

    uint32_t c;
    while ((c = next_cp((uint8_t **)&string))) {
        draw_char(font, buffer, &local_cursor_x, local_cursor_y, (uint16_t)buf_width,
                  (uint16_t)buf_height, c, &props);
    }

    *cursor_x += local_cursor_x - cursor_x_init;
    *cursor_y += local_cursor_y - cursor_y_init;
}

void writeln(const GFXfont *font, const char *string, int32_t *cursor_x, int32_t *cursor_y,
             uint8_t *framebuffer)
{
    write_mode(font, string, cursor_x, cursor_y, framebuffer, BLACK_ON_WHITE, NULL);
}

void write_string(const GFXfont *font, const char *string, int32_t *cursor_x, int32_t *cursor_y,
                  uint8_t *framebuffer)
{
    if (string == NULL) {
        return;
    }
    char *tofree = strdup(string);
    if (!tofree) {
        return;
    }
    char *newstring = tofree;
    int32_t line_start = *cursor_x;
    char *token;
    while ((token = strsep(&newstring, "\n")) != NULL) {
        *cursor_x = line_start;
        writeln(font, token, cursor_x, cursor_y, framebuffer);
        *cursor_y += font->advance_y;
    }
    free(tofree);
}

static int32_t utf8_len(const uint8_t ch)
{
    int32_t len = 0;
    for (utf_t **u = utf; *u; ++u) {
        if ((ch & ~(*u)->mask) == (*u)->lead) {
            break;
        }
        ++len;
    }
    if (len > 4) {
        return 1;
    }
    return len;
}

static uint32_t next_cp(uint8_t **string)
{
    if (**string == 0) {
        return 0;
    }

    int32_t bytes = utf8_len(**string);
    if (bytes == 0 || bytes > 4) {
        (*string)++;
        return 0xFFFD;
    }

    uint8_t *chr = *string;
    *string += bytes;
    int32_t shift = utf[0]->bits_stored * (bytes - 1);
    uint32_t codep = (*chr++ & utf[bytes]->mask) << shift;

    for (int32_t i = 1; i < bytes; ++i, ++chr) {
        shift -= utf[0]->bits_stored;
        codep |= ((uint8_t)*chr & utf[0]->mask) << shift;
    }
    return codep;
}

static FontProperties font_properties_default(void)
{
    FontProperties props = {
        .fg_color = 0,
        .bg_color = 15,
        .fallback_glyph = 0,
        .flags = 0,
    };
    return props;
}

static void draw_char(const GFXfont *font, uint8_t *buffer, int32_t *cursor_x, int32_t cursor_y,
                      uint16_t buf_width, uint16_t buf_height, uint32_t cp,
                      const FontProperties *props)
{
    GFXglyph *glyph;
    get_glyph(font, cp, &glyph);
    if (!glyph) {
        get_glyph(font, props->fallback_glyph, &glyph);
    }
    if (!glyph) {
        return;
    }

    if (font->compressed) {
        fprintf(stderr, "acd-ui-sim: compressed fonts are not supported on host\n");
        *cursor_x += glyph->advance_x;
        return;
    }

    uint32_t offset = glyph->data_offset;
    uint8_t width = glyph->width;
    uint8_t height = glyph->height;
    int32_t left = glyph->left;
    int32_t byte_width = (width / 2 + width % 2);
    uint8_t *bitmap = &font->bitmap[offset];

    uint8_t color_lut[16];
    for (int32_t c = 0; c < 16; c++) {
        int32_t color_difference = (int32_t)props->fg_color - (int32_t)props->bg_color;
        color_lut[c] = (uint8_t)max_i32(0, min_i32(15, props->bg_color + c * color_difference / 15));
    }

    for (int32_t y = 0; y < height; y++) {
        int32_t yy = cursor_y - glyph->top + y;
        if (yy < 0 || yy >= buf_height) {
            continue;
        }
        int32_t start_pos = *cursor_x + left;
        int32_t x = max_i32(0, -start_pos);
        int32_t max_x = min_i32(start_pos + width, buf_width * 2);
        for (int32_t xx = max_i32(0, start_pos); xx < max_x; xx++) {
            uint32_t buf_pos = (uint32_t)yy * buf_width + (uint32_t)xx / 2;
            uint8_t old = buffer[buf_pos];
            uint8_t bm = bitmap[y * byte_width + x / 2];
            if ((x & 1) == 0) {
                bm = bm & 0xF;
            } else {
                bm = bm >> 4;
            }
            if ((xx & 1) == 0) {
                buffer[buf_pos] = (old & 0xF0) | color_lut[bm];
            } else {
                buffer[buf_pos] = (old & 0x0F) | (color_lut[bm] << 4);
            }
            x++;
        }
    }
    *cursor_x += glyph->advance_x;
}

static void get_char_bounds(const GFXfont *font, uint32_t cp, int32_t *x, int32_t *y, int32_t *minx,
                            int32_t *miny, int32_t *maxx, int32_t *maxy,
                            const FontProperties *props)
{
    GFXglyph *glyph;
    get_glyph(font, cp, &glyph);
    if (!glyph) {
        get_glyph(font, props->fallback_glyph, &glyph);
    }
    if (!glyph) {
        return;
    }

    int32_t x1 = *x + glyph->left;
    int32_t y1 = *y + (glyph->top - glyph->height);
    int32_t x2 = x1 + glyph->width;
    int32_t y2 = y1 + glyph->height;

    if (props->flags & DRAW_BACKGROUND) {
        *minx = min_i32(*x, min_i32(*minx, x1));
        *maxx = max_i32(max_i32(*x + glyph->advance_x, x2), *maxx);
        *miny = min_i32(*y + font->descender, min_i32(*miny, y1));
        *maxy = max_i32(font->descender + font->advance_y, max_i32(*maxy, y2));
    } else {
        if (x1 < *minx) {
            *minx = x1;
        }
        if (y1 < *miny) {
            *miny = y1;
        }
        if (x2 > *maxx) {
            *maxx = x2;
        }
        if (y2 > *maxy) {
            *maxy = y2;
        }
    }
    *x += glyph->advance_x;
}
