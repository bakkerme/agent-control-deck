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

    epd_poweron();
    if (full_clear) {
        epd_clear();
    }
    epd_draw_grayscale_image(epd_full_screen(), s_framebuffer);
    epd_poweroff();
}
