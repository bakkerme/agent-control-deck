import { z } from "zod";
import { states } from "./types";
const id = z.string().min(1).max(200);
const name = z.string().trim().min(1, "A name is required").max(200);
export const ticketUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Use a complete http:// or https:// URL without credentials");
export const jiraBaseUrl = ticketUrl.refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return !url.search && !url.hash;
  } catch { return false; }
}, "Use a Jira base URL without query parameters or a fragment")
  .transform((value) => value.replace(/\/+$/, ""));
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("updateSettings"), jiraBaseUrl: jiraBaseUrl }).strict(),
  z.object({ type: z.literal("createProject"), name, chatId: id.optional() }).strict(),
  z.object({ type: z.literal("renameProject"), id, name }).strict(),
  z.object({ type: z.literal("setProjectPriority"), id, priority: z.boolean() }).strict(),
  z.object({ type: z.literal("createChat"), projectId: id.nullable(), name }).strict(),
  z
    .object({
      type: z.literal("updateChat"),
      id,
      patch: z
        .object({
          name: z.string().trim().max(200),
          notes: z.string().max(100000),
          jiraKey: z.string().trim().max(100),
          jiraUrl: ticketUrl,
          projectId: id.nullable(),
          archived: z.boolean(),
          state: z.enum(states),
          lifecycle: z.enum(["open", "ended"]),
        })
        .partial()
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("createSource"),
      name,
      provider: z.enum(["claude", "cursor", "codex"]),
      environment: z.enum(["native", "wsl"]),
    })
    .strict(),
  z
    .object({ type: z.literal("updateSource"), id, enabled: z.boolean() })
    .strict(),
  z
    .object({
      type: z.literal("addWorkspace"),
      sourceId: id,
      projectId: id,
      path: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z.object({ type: z.literal("removeWorkspace"), id }).strict(),
  z.object({ type: z.literal("testSource"), id }).strict(),
  z.object({ type: z.literal("setDemo"), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal("advanceDemo") }).strict(),
]);
export const idSchema = id;
export const envelopeSchema = z
  .object({
    version: z.literal(1),
    eventId: id,
    observedAt: z.string().datetime({ offset: true }).optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
