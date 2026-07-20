/**
 * Display helpers — e-paper init, framebuffer, power, present.
 *
 * Target: LilyGo T5-ePaper (ESP32-WROVER), 960x540, 4-bit grayscale.
 */

#pragma once

#include <stdint.h>

/** Allocate PSRAM framebuffer and call epd_init(). Returns false on alloc failure. */
bool display_init();

/** Pointer to the off-screen 4-bit grayscale framebuffer (null until display_init). */
uint8_t *display_framebuffer();

/**
 * Power on, optionally full-panel clear, draw framebuffer full screen, power off.
 * @param full_clear if true, epd_clear() before draw (use on first present / every N frames).
 */
void display_present(bool full_clear);
