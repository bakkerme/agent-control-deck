/**
 * Display helpers — e-paper power, clear, present.
 */

#include "display.h"

#include <Arduino.h>

#include "epd_driver.h"

static uint8_t *s_framebuffer = nullptr;

bool display_init()
{
    if (s_framebuffer) {
        return true;
    }

    s_framebuffer = (uint8_t *)ps_calloc(EPD_WIDTH * EPD_HEIGHT / 2, sizeof(uint8_t));
    if (!s_framebuffer) {
        return false;
    }

    epd_init();
    return true;
}

uint8_t *display_framebuffer()
{
    return s_framebuffer;
}

void display_present(bool full_clear)
{
    if (!s_framebuffer) {
        return;
    }

    /*
     * LilyGo EPD47 grayscale present is BLACK_ON_WHITE only: it can darken
     * pixels but never lighten them. Drawing a new frame without a clear leaves
     * prior ink (status text stacks, empty-state copy ghosts next to rows).
     *
     * MVP: always full-panel clear then full-frame draw (product non-goal is
     * perfect partial refresh). full_clear is retained for API stability;
     * callers should pass true. Future row-scoped updates: epd_clear_area(rect)
     * then draw (either direct writeln to glass or a cropped grayscale blit).
     */
    (void)full_clear;

    epd_poweron();
    epd_clear();
    epd_draw_grayscale_image(epd_full_screen(), s_framebuffer);
    epd_poweroff();
}
