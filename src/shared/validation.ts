import { z } from "zod";
import { states } from "./types";
import { planCategories, validPlanDay } from "./planning";
const day = z.string().refine(validPlanDay, "Choose a valid YYYY-MM-DD date");
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
export const jiraBaseUrl = ticketUrl
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return !url.search && !url.hash;
    } catch {
      return false;
    }
  }, "Use a Jira base URL without query parameters or a fragment")
  .transform((value) => value.replace(/\/+$/, ""));
export const linkRulesSchema = z
  .array(
    z
      .object({
        domain: z
          .string()
          .trim()
          .min(1)
          .max(253)
          .transform((value) => value.toLowerCase())
          .refine((value) => {
            try {
              if (
                !value
                  .split(".")
                  .every((label) =>
                    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
                  )
              )
                return false;
              const url = new URL(`https://${value}`);
              return (
                url.hostname === value &&
                !url.port &&
                !url.username &&
                !url.password &&
                url.pathname === "/" &&
                !url.search &&
                !url.hash &&
                !value.endsWith(".")
              );
            } catch {
              return false;
            }
          }, "Enter a domain only, such as docs.example.com"),
        pathPrefix: z
          .string()
          .trim()
          .max(1000)
          .refine(
            (value) =>
              !value || (value.startsWith("/") && !/[\s?#\\]/.test(value)),
            "Use a path such as /wiki, without spaces, a query or fragment",
          )
          .transform((value) => value.replace(/\/+$/, "")),
        category: z.string().trim().min(1, "A category is required").max(100),
      })
      .strict(),
  )
  .max(50)
  .refine(
    (rules) =>
      new Set(rules.map((rule) => `${rule.domain}\n${rule.pathPrefix}`))
        .size === rules.length,
    "Each domain and path combination needs just one category",
  );
const planTicket = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine(
        (value) =>
          /^[A-Z][A-Z0-9_]*-\d+$/i.test(value) ||
          ticketUrl.safeParse(value).success,
        "Use a ticket number or a complete web URL",
      ),
    status: z.string().max(50),
    note: z.string().max(500),
  })
  .strict();
const planTickets = z
  .array(planTicket)
  .max(100)
  .refine(
    (rows) => new Set(rows.map((r) => r.key)).size === rows.length,
    "This ticket is already linked",
  );
const webUrl = ticketUrl.refine((value) => !!value, "A URL is required");
const planLinks = z
  .array(
    z
      .object({
        url: webUrl,
        label: z.string().max(500),
        category: z.string().trim().min(1).max(100),
      })
      .strict(),
  )
  .max(1000)
  .refine(
    (rows) => new Set(rows.map((r) => r.url)).size === rows.length,
    "This URL is already linked",
  );
export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("createPlanItem"),
      day,
      category: z.enum(planCategories),
      name,
      notes: z.string().max(100000).optional(),
      tickets: planTickets.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("updatePlanItem"),
      id,
      patch: z
        .object({
          name,
          notes: z.string().max(100000),
          projectId: id.nullable(),
          tickets: planTickets,
          links: planLinks,
          hiddenLinks: z.array(webUrl).max(1000),
          categoryOverrides: z
            .record(z.string().max(100), z.string().trim().min(1).max(100))
            .refine(
              (value) => Object.keys(value).length <= 1000,
              "Too many categories",
            ),
        })
        .partial()
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("updatePlanEntry"),
      id,
      day,
      name: name.optional(),
      category: z.enum(planCategories).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reorderPlanEntry"),
      id,
      day,
      category: z.enum(planCategories),
      beforeId: id.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("setDayWrapup"),
      day,
      notes: z.string().max(100000),
    })
    .strict(),
  z
    .object({
      type: z.literal("savePlanDraft"),
      key: z
        .string()
        .regex(
          /^(card-review|task-create|(?:notes|tickets|links|categories):[\w-]+|wrap:\d{4}-\d{2}-\d{2})$/,
        ),
      value: z.string().max(200000).nullable(),
    })
    .strict(),
  z.object({ type: z.literal("undoPlanning"), undoId: id }).strict(),
  z
    .object({
      type: z.literal("setPlanChats"),
      id,
      chatIds: z.array(id).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("schedulePlanItem"),
      id,
      day,
      category: z.enum(planCategories),
      name: name.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reschedulePlanItem"),
      id,
      fromDay: day,
      day,
      category: z.enum(planCategories),
    })
    .strict(),
  z
    .object({
      type: z.literal("removePlanEntry"),
      id,
      day,
      confirmLast: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("deletePlanItem"), id }).strict(),
  z
    .object({
      type: z.literal("setPlanWorkedOn"),
      id,
      day,
      workedOn: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("importDailyPlan"),
      card: z.string().max(100000),
      sourceName: name,
      itemIds: z.array(id.nullable()).max(200),
      names: z.array(name).max(200).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("updateSettings"),
      jiraBaseUrl: jiraBaseUrl.optional(),
      linkRules: linkRulesSchema.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.jiraBaseUrl !== undefined || value.linkRules !== undefined,
      "Choose settings to update",
    ),
  z
    .object({ type: z.literal("createProject"), name, chatId: id.optional() })
    .strict(),
  z.object({ type: z.literal("renameProject"), id, name }).strict(),
  z
    .object({
      type: z.literal("setProjectPriority"),
      id,
      priority: z.boolean(),
    })
    .strict(),
  z
    .object({ type: z.literal("createChat"), projectId: id.nullable(), name })
    .strict(),
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
