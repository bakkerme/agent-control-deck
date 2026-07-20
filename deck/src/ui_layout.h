/**
 * E-paper status layout: header + up to 3 session rows + footer.
 */

#pragma once

#include <stdint.h>

#include "status_model.h"

/**
 * Clear framebuffer to white and draw the full status layout for @p view.
 * Uses FiraSans, ASCII state tokens, and geometric progress bars (epd_*_rect).
 * Does not power the panel or present — caller uses display_present().
 */
void ui_draw_status(uint8_t *framebuffer, const DeckView *view);
