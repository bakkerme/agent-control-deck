/**
 * Host software-only subset of LilyGo-EPD47 / epdiy drawing APIs.
 *
 * Used by the PC UI sim (deck/sim) so firmware layout sources can compile
 * without ESP-IDF or panel hardware. Geometry and 4-bit packing match device.
 *
 * Adapted from LilyGo-EPD47 (GPL-3.0) software framebuffer helpers.
 */

#ifndef ACD_HOST_EPD_DRIVER_H_
#define ACD_HOST_EPD_DRIVER_H_

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

#ifndef IRAM_ATTR
#define IRAM_ATTR
#endif

#define EPD_WIDTH 960
#define EPD_HEIGHT 540

typedef struct {
    int32_t x;
    int32_t y;
    int32_t width;
    int32_t height;
} Rect_t;

typedef enum {
    BLACK_ON_WHITE = 1 << 0,
    WHITE_ON_WHITE = 1 << 1,
    WHITE_ON_BLACK = 1 << 2,
} DrawMode_t;

enum DrawFlags {
    DRAW_BACKGROUND = 1 << 0,
};

typedef struct {
    uint8_t fg_color : 4;
    uint8_t bg_color : 4;
    uint32_t fallback_glyph;
    uint32_t flags;
} FontProperties;

typedef struct {
    uint8_t width;
    uint8_t height;
    uint8_t advance_x;
    int16_t left;
    int16_t top;
    uint16_t compressed_size;
    uint32_t data_offset;
} GFXglyph;

typedef struct {
    uint32_t first;
    uint32_t last;
    uint32_t offset;
} UnicodeInterval;

typedef struct {
    uint8_t *bitmap;
    GFXglyph *glyph;
    UnicodeInterval *intervals;
    uint32_t interval_count;
    bool compressed;
    uint8_t advance_y;
    int32_t ascender;
    int32_t descender;
} GFXfont;

void epd_draw_pixel(int32_t x, int32_t y, uint8_t color, uint8_t *framebuffer);
void epd_draw_hline(int32_t x, int32_t y, int32_t length, uint8_t color, uint8_t *framebuffer);
void epd_draw_vline(int32_t x, int32_t y, int32_t length, uint8_t color, uint8_t *framebuffer);
void epd_draw_circle(int32_t x, int32_t y, int32_t r, uint8_t color, uint8_t *framebuffer);
void epd_fill_circle(int32_t x, int32_t y, int32_t r, uint8_t color, uint8_t *framebuffer);
void epd_fill_rect(int32_t x, int32_t y, int32_t w, int32_t h, uint8_t color, uint8_t *framebuffer);
void epd_draw_line(int32_t x0, int32_t y0, int32_t x1, int32_t y1, uint8_t color, uint8_t *framebuffer);

void get_text_bounds(const GFXfont *font, const char *string, int32_t *x, int32_t *y, int32_t *x1,
                     int32_t *y1, int32_t *w, int32_t *h, const FontProperties *props);
void writeln(const GFXfont *font, const char *string, int32_t *cursor_x, int32_t *cursor_y,
             uint8_t *framebuffer);
void write_mode(const GFXfont *font, const char *string, int32_t *cursor_x, int32_t *cursor_y,
                uint8_t *framebuffer, DrawMode_t mode, const FontProperties *properties);
void get_glyph(const GFXfont *font, uint32_t code_point, GFXglyph **glyph);
void write_string(const GFXfont *font, const char *string, int32_t *cursor_x, int32_t *cursor_y,
                  uint8_t *framebuffer);

#ifdef __cplusplus
}
#endif

#endif /* ACD_HOST_EPD_DRIVER_H_ */
