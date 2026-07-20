/**
 * Agent Control Deck — e-paper hello world
 *
 * Target: LilyGo T5-ePaper (ESP32-WROVER), 960x540, 4-bit grayscale.
 * Requires BOARD_HAS_PSRAM (set in platformio.ini / board JSON).
 */

#ifndef BOARD_HAS_PSRAM
#error "PSRAM is required. Build with BOARD_HAS_PSRAM (see platformio.ini)."
#endif

#include <Arduino.h>
#include <string.h>

#include "epd_driver.h"
#include "firasans.h"

static uint8_t *framebuffer = nullptr;

static void draw_hello()
{
    // White background in the off-screen buffer (0xFF = white for this panel).
    memset(framebuffer, 0xFF, EPD_WIDTH * EPD_HEIGHT / 2);

    // Border
    epd_draw_rect(20, 20, EPD_WIDTH - 40, EPD_HEIGHT - 40, 0, framebuffer);

    // Title
    int32_t cursor_x = 60;
    int32_t cursor_y = 160;
    writeln((GFXfont *)&FiraSans, "Hello, Agent Control Deck", &cursor_x, &cursor_y,
            framebuffer);

    // Subtitle
    cursor_x = 60;
    cursor_y = 240;
    writeln((GFXfont *)&FiraSans, "LilyGo T5-ePaper / ESP32", &cursor_x, &cursor_y,
            framebuffer);

    cursor_x = 60;
    cursor_y = 300;
    writeln((GFXfont *)&FiraSans, "deck/ hello world", &cursor_x, &cursor_y, framebuffer);
}

void setup()
{
    Serial.begin(115200);
    delay(500);
    Serial.println();
    Serial.println("agent-control-deck/deck: hello world");

    framebuffer = (uint8_t *)ps_calloc(EPD_WIDTH * EPD_HEIGHT / 2, sizeof(uint8_t));
    if (!framebuffer) {
        Serial.println("PSRAM framebuffer alloc failed");
        while (true) {
            delay(1000);
        }
    }

    epd_init();

    epd_poweron();
    epd_clear();
    draw_hello();
    epd_draw_grayscale_image(epd_full_screen(), framebuffer);
    epd_poweroff();

    Serial.println("Hello world drawn to e-paper.");
}

void loop()
{
    // Static hello world — nothing to refresh.
    delay(10000);
}
