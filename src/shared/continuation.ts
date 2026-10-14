import { z } from "zod";

// Import-review suggestions: which task from recent cards does a new card entry continue?
// Suggestions are never applied without review; the user confirms them in the import review.
export const continuationInputSchema = z
  .object({
    card: z.string().min(1).max(100000),
    index: z.number().int().min(0).max(199),
    // Tasks already chosen by other entries on this card; one task cannot continue twice.
    taken: z.array(z.string().min(1).max(200)).max(200),
    // false: instant local checks only (same ticket, same title). true: may also ask the model.
    model: z.boolean(),
  })
  .strict();
export type ContinuationInput = z.infer<typeof continuationInputSchema>;

export interface ContinuationSuggestion {
  itemId: string | null;
  // suggested: confident enough to pre-select. maybe: shown as a hint only.
  strength: "suggested" | "maybe" | "none";
  source: "ticket" | "name" | "model" | "none";
  reason: string;
}
export const noContinuation = (reason = ""): ContinuationSuggestion => ({
  itemId: null,
  strength: "none",
  source: "none",
  reason,
});

export interface ContinuationCandidate {
  id: string;
  title: string;
  aliases?: string[];
  ticket_keys: string[];
}
const normalize = (name: string) =>
  name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Free of any model: an identical title, or a ticket only one candidate carries, is decisive.
export function quickContinuation(
  entry: { name: string; ticketKeys: string[] },
  candidates: ContinuationCandidate[],
): ContinuationSuggestion | null {
  const name = normalize(entry.name);
  const named = name ? candidates.filter((c) => [c.title, ...(c.aliases ?? [])].some((t) => normalize(t) === name)) : [];
  if (named.length === 1)
    return { itemId: named[0].id, strength: "suggested", source: "name", reason: "Same title as an earlier card" };
  const keys = new Set(entry.ticketKeys.map((key) => key.toUpperCase()));
  const ticketed = candidates.filter((c) => c.ticket_keys.some((key) => keys.has(key.toUpperCase())));
  if (ticketed.length === 1) {
    const shared = ticketed[0].ticket_keys.find((key) => keys.has(key.toUpperCase()))!;
    return { itemId: ticketed[0].id, strength: "suggested", source: "ticket", reason: `Shares ticket ${shared}` };
  }
  return null;
}
