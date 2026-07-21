/**
 * E-paper status layout (design C): top bar + up to 8 session rows.
 */

#pragma once

#include <stdint.h>

#include "status_model.h"

/**
 * Clear framebuffer to white and draw the full status layout for @p view.
 * Geometric state icons + FiraSansUI path/summary. No progress bars / no footer.
 * Does not power the panel or present — caller uses display_present().
 */
void ui_draw_status(uint8_t *framebuffer, const DeckView *view);
