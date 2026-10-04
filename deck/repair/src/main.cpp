/**
 * Aggressive e-paper recovery for LilyGo T5-ePaper (classic ESP32).
 *
 * Stock LilyGo screen_repair still does a long black phase first. When the
 * glass is already mud/dark, that can make contrast worse. This sketch:
 *   1. Powers on and runs long white-only drive cycles
 *   2. Alternating clear cycles (dark→white pairs, more white time)
 *   3. Ends with more white-only drive + a final clear
 *
 * Flash (USB power recommended; leave plugged in the whole run):
 *   cd deck && pio run -e repair -t upload && pio device monitor
 *
 * Expect ~5–10 minutes of flashing. Serial logs progress at 115200.
 * When done, reflash normal firmware:
 *   pio run -e T5-ePaper -t upload
 */

#include <Arduino.h>
#include "epd_driver.h"

#ifndef BOARD_HAS_PSRAM
#error "Enable PSRAM (BOARD_HAS_PSRAM) for T5-ePaper"
#endif

static void push_white(int n, int16_t time_us)
{
    Rect_t area = epd_full_screen();
    for (int i = 0; i < n; i++) {
        epd_push_pixels(area, time_us, 1); /* 1 = lighten / white */
        delay(200);
        if ((i + 1) % 10 == 0) {
            Serial.printf("  white push %d/%d\n", i + 1, n);
        }
    }
}

static void push_dark(int n, int16_t time_us)
{
    Rect_t area = epd_full_screen();
    for (int i = 0; i < n; i++) {
        epd_push_pixels(area, time_us, 0); /* 0 = darken / black */
        delay(200);
        if ((i + 1) % 10 == 0) {
            Serial.printf("  dark push %d/%d\n", i + 1, n);
        }
    }
}

void setup()
{
    Serial.begin(115200);
    delay(500);
    Serial.println();
    Serial.println("ACD aggressive e-paper recovery");
    Serial.println("USB power recommended. Do not unplug mid-run.");

    epd_init();
    epd_poweron();
    delay(50);

    /* Phase A: white-only — already dark panels need lightening first. */
    Serial.println("Phase A: white-only (80 x long pulse)");
    push_white(80, 80);

    Serial.println("Phase A2: epd_clear()");
    epd_clear();
    delay(500);

    /* Phase B: more white after clear. */
    Serial.println("Phase B: white-only (60 x long pulse)");
    push_white(60, 100);

    Serial.println("Phase B2: epd_clear_area_cycles(full, 12, 80)");
    epd_clear_area_cycles(epd_full_screen(), 12, 80);
    delay(500);

    /* Phase C: short dark → long white (classic clean cycles, white-heavy). */
    Serial.println("Phase C: 8 dark + 40 white (x 6 rounds)");
    for (int round = 0; round < 6; round++) {
        Serial.printf("  round %d/6\n", round + 1);
        push_dark(8, 50);
        push_white(40, 80);
        epd_clear();
        delay(300);
    }

    /* Phase D: finish white-heavy. */
    Serial.println("Phase D: white-only (80 x long pulse) + final clear");
    push_white(80, 100);
    epd_clear();
    delay(300);
    epd_clear_area_cycles(epd_full_screen(), 8, 100);

    epd_poweroff_all();
    Serial.println("DONE. Leave powered a few seconds, then unplug or reflash ACD.");
    Serial.println("If still dark: run again once, or panel may be failing.");
}

void loop()
{
    delay(1000);
}
