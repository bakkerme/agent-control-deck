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
 * Power on, clear panel, draw full-screen framebuffer, power off.
 *
 * Grayscale blit is black-on-white only and cannot erase prior ink, so every
 * present clears first. @p full_clear is currently ignored (always clears);
 * kept so call sites can later request area-scoped clears without API churn.
 */
void display_present(bool full_clear);
