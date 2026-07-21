/**
 * Software framebuffer primitives for host UI sim.
 * Adapted from LilyGo-EPD47 src/epd_driver.c (GPL-3.0) software path only.
 */

#include "epd_driver.h"

#include <stdlib.h>

#define _swap_int(a, b)  \
    do {                 \
        int32_t t = (a); \
        (a) = (b);       \
        (b) = t;         \
    } while (0)

static void epd_fill_circle_helper(int32_t x0, int32_t y0, int32_t r, int32_t corners, int32_t delta,
                                   uint8_t color, uint8_t *framebuffer);
static void epd_write_line(int32_t x0, int32_t y0, int32_t x1, int32_t y1, uint8_t color,
                           uint8_t *framebuffer);

void epd_draw_hline(int32_t x, int32_t y, int32_t length, uint8_t color, uint8_t *framebuffer)
{
    for (int32_t i = 0; i < length; i++) {
        epd_draw_pixel(x + i, y, color, framebuffer);
    }
}

void epd_draw_vline(int32_t x, int32_t y, int32_t length, uint8_t color, uint8_t *framebuffer)
{
    for (int32_t i = 0; i < length; i++) {
        epd_draw_pixel(x, y + i, color, framebuffer);
    }
}

void epd_draw_pixel(int32_t x, int32_t y, uint8_t color, uint8_t *framebuffer)
{
    if (x < 0 || x >= EPD_WIDTH || y < 0 || y >= EPD_HEIGHT || !framebuffer) {
        return;
    }
    uint8_t *buf_ptr = &framebuffer[y * EPD_WIDTH / 2 + x / 2];
    if (x % 2) {
        *buf_ptr = (*buf_ptr & 0x0F) | (color & 0xF0);
    } else {
        *buf_ptr = (*buf_ptr & 0xF0) | (color >> 4);
    }
}

void epd_draw_circle(int32_t x0, int32_t y0, int32_t r, uint8_t color, uint8_t *framebuffer)
{
    int32_t f = 1 - r;
    int32_t ddF_x = 1;
    int32_t ddF_y = -2 * r;
    int32_t x = 0;
    int32_t y = r;

    epd_draw_pixel(x0, y0 + r, color, framebuffer);
    epd_draw_pixel(x0, y0 - r, color, framebuffer);
    epd_draw_pixel(x0 + r, y0, color, framebuffer);
    epd_draw_pixel(x0 - r, y0, color, framebuffer);

    while (x < y) {
        if (f >= 0) {
            y--;
            ddF_y += 2;
            f += ddF_y;
        }
        x++;
        ddF_x += 2;
        f += ddF_x;

        epd_draw_pixel(x0 + x, y0 + y, color, framebuffer);
        epd_draw_pixel(x0 - x, y0 + y, color, framebuffer);
        epd_draw_pixel(x0 + x, y0 - y, color, framebuffer);
        epd_draw_pixel(x0 - x, y0 - y, color, framebuffer);
        epd_draw_pixel(x0 + y, y0 + x, color, framebuffer);
        epd_draw_pixel(x0 - y, y0 + x, color, framebuffer);
        epd_draw_pixel(x0 + y, y0 - x, color, framebuffer);
        epd_draw_pixel(x0 - y, y0 - x, color, framebuffer);
    }
}

void epd_fill_circle(int32_t x0, int32_t y0, int32_t r, uint8_t color, uint8_t *framebuffer)
{
    epd_draw_vline(x0, y0 - r, 2 * r + 1, color, framebuffer);
    epd_fill_circle_helper(x0, y0, r, 3, 0, color, framebuffer);
}

static void epd_fill_circle_helper(int32_t x0, int32_t y0, int32_t r, int32_t corners, int32_t delta,
                                   uint8_t color, uint8_t *framebuffer)
{
    int32_t f = 1 - r;
    int32_t ddF_x = 1;
    int32_t ddF_y = -2 * r;
    int32_t x = 0;
    int32_t y = r;
    int32_t px = x;
    int32_t py = y;

    delta++;

    while (x < y) {
        if (f >= 0) {
            y--;
            ddF_y += 2;
            f += ddF_y;
        }
        x++;
        ddF_x += 2;
        f += ddF_x;
        if (x < (y + 1)) {
            if (corners & 1) {
                epd_draw_vline(x0 + x, y0 - y, 2 * y + delta, color, framebuffer);
            }
            if (corners & 2) {
                epd_draw_vline(x0 - x, y0 - y, 2 * y + delta, color, framebuffer);
            }
        }
        if (y != py) {
            if (corners & 1) {
                epd_draw_vline(x0 + py, y0 - px, 2 * px + delta, color, framebuffer);
            }
            if (corners & 2) {
                epd_draw_vline(x0 - py, y0 - px, 2 * px + delta, color, framebuffer);
            }
            py = y;
        }
        px = x;
    }
}

void epd_fill_rect(int32_t x, int32_t y, int32_t w, int32_t h, uint8_t color, uint8_t *framebuffer)
{
    for (int32_t i = x; i < x + w; i++) {
        epd_draw_vline(i, y, h, color, framebuffer);
    }
}

static void epd_write_line(int32_t x0, int32_t y0, int32_t x1, int32_t y1, uint8_t color,
                           uint8_t *framebuffer)
{
    int32_t steep = abs(y1 - y0) > abs(x1 - x0);
    if (steep) {
        _swap_int(x0, y0);
        _swap_int(x1, y1);
    }
    if (x0 > x1) {
        _swap_int(x0, x1);
        _swap_int(y0, y1);
    }

    int32_t dx = x1 - x0;
    int32_t dy = abs(y1 - y0);
    int32_t err = dx / 2;
    int32_t ystep = (y0 < y1) ? 1 : -1;

    for (; x0 <= x1; x0++) {
        if (steep) {
            epd_draw_pixel(y0, x0, color, framebuffer);
        } else {
            epd_draw_pixel(x0, y0, color, framebuffer);
        }
        err -= dy;
        if (err < 0) {
            y0 += ystep;
            err += dx;
        }
    }
}

void epd_draw_line(int32_t x0, int32_t y0, int32_t x1, int32_t y1, uint8_t color,
                   uint8_t *framebuffer)
{
    if (x0 == x1) {
        if (y0 > y1) {
            _swap_int(y0, y1);
        }
        epd_draw_vline(x0, y0, y1 - y0 + 1, color, framebuffer);
    } else if (y0 == y1) {
        if (x0 > x1) {
            _swap_int(x0, x1);
        }
        epd_draw_hline(x0, y0, x1 - x0 + 1, color, framebuffer);
    } else {
        epd_write_line(x0, y0, x1, y1, color, framebuffer);
    }
}
