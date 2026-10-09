import { parse } from "yaml";
export const planCategories = ["Coding", "Agentic", "Other"] as const;
export type PlanCategory = (typeof planCategories)[number];
export interface PlanItem {
  id: string;
  name: string;
  notes: string;
  projectId: string | null;
  chatIds: string[];
  createdAt: string;
  updatedAt: string;
}
export interface PlanEntry {
  day: string;
  itemId: string;
  category: PlanCategory;
  workedOn: boolean;
  position: number;
}
export interface PlanImport {
  id: string;
  day: string;
  sourceName: string;
  card: string;
  importedAt: string;
}
export interface PlanInboxFile {
  name: string;
  card: string;
  error: string | null;
}
export interface PlanningSnapshot {
  items: PlanItem[];
  entries: PlanEntry[];
  imports: PlanImport[];
  inbox: { path: string; files: PlanInboxFile[]; error: string | null };
}
export const categoryDescription: Record<PlanCategory, string> = {
  Coding: "Coding work with AI",
  Agentic: "Work delegated to AI",
  Other: "Work mostly done by you — reviews, conversations, and follow-ups",
};
export function validPlanDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= "1900-01-01" &&
    value <= "9999-12-31" &&
    !Number.isNaN(Date.parse(value + "T12:00:00Z")) &&
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value
  );
}
export function localPlanDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function nextPlanDay(day: string, offset = 1): string {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export interface PlanTicket {
  key: string;
  status: string;
  note: string;
}
export interface ParsedPlanItem {
  name: string;
  category: PlanCategory;
  tickets: PlanTicket[];
  related: PlanTicket[];
  note: string;
}
export interface ParsedPlan {
  day: string;
  items: ParsedPlanItem[];
}
const ticketKey = /^[A-Z][A-Z0-9]*-\d+$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function text(value: unknown, where: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`${where} must be text`);
  const result = String(value).trim();
  if (result.length > max)
    throw new Error(`${where} must be at most ${max} characters`);
  return result;
}
function ticket(value: unknown, where: string): PlanTicket {
  const fields = typeof value === "string" ? { key: value } : value;
  if (!isRecord(fields))
    throw new Error(`${where} must be a ticket key or a mapping`);
  for (const field of Object.keys(fields))
    if (!["key", "status", "note"].includes(field))
      throw new Error(`${where} has unknown field "${field}"`);
  const key = text(fields.key, `${where} key`, 100).toUpperCase();
  if (!ticketKey.test(key))
    throw new Error(`${where} needs a Jira key such as DECK-101`);
  return {
    key,
    status: text(fields.status, `${where} status`, 50),
    note: text(fields.note, `${where} note`, 500),
  };
}
function tickets(value: unknown, where: string): PlanTicket[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${where} must be a list`);
  if (value.length > 20)
    throw new Error(`${where} can contain at most 20 tickets`);
  const result = value.map((v, n) => ticket(v, `${where} ${n + 1}`));
  if (new Set(result.map((t) => t.key)).size !== result.length)
    throw new Error(`${where} lists a ticket twice`);
  return result;
}
// YAML contract: `date` plus `coding`, `agentic`, and `other` lists. An item is
// a name, or a mapping of `name`, `tickets`, `related`, and `note`. Tickets and
// annotations have their own fields, so nothing is split out of prose. Project
// relationships, chat links, and progress always remain user decisions.
export function parseDailyPlan(card: string): ParsedPlan {
  if (card.length > 100000) throw new Error("Card exceeds 100,000 characters");
  let document: unknown;
  try {
    // Aliases are refused so a small card cannot expand into a large one.
    document = parse(card.replace(/^﻿/, ""), { maxAliasCount: 0 });
  } catch (e) {
    throw new Error(
      `The card is not valid YAML: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`,
    );
  }
  if (!isRecord(document))
    throw new Error(
      "Write the card as YAML: a date and coding, agentic, or other lists",
    );
  const sections = new Map<PlanCategory, unknown>();
  let day = "";
  for (const [key, value] of Object.entries(document)) {
    if (key === "date") {
      day = String(value ?? "");
      continue;
    }
    const category = planCategories.find(
      (c) => c.toLowerCase() === key.toLowerCase(),
    );
    if (!category)
      throw new Error(
        `Unknown section: ${key}. Use date, coding, agentic, or other.`,
      );
    if (sections.has(category)) throw new Error(`${category} appears twice`);
    sections.set(category, value);
  }
  if (!validPlanDay(day)) throw new Error("Add a valid date: YYYY-MM-DD");
  const items: ParsedPlanItem[] = [];
  for (const category of planCategories) {
    const list = sections.get(category);
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list))
      throw new Error(`${category} must be a list of items`);
    list.forEach((raw, n) => {
      const where = `${category} item ${n + 1}`,
        fields = typeof raw === "string" ? { name: raw } : raw;
      if (!isRecord(fields))
        throw new Error(`${where} must be a name or a mapping`);
      for (const field of Object.keys(fields))
        if (!["name", "tickets", "related", "note"].includes(field))
          throw new Error(`${where} has unknown field "${field}"`);
      const name = text(fields.name, `${where} name`, 200);
      if (!name) throw new Error(`${where} needs a name`);
      items.push({
        name,
        category,
        tickets: tickets(fields.tickets, `${where} tickets`),
        related: tickets(fields.related, `${where} related`),
        note: text(fields.note, `${where} note`, 2000),
      });
      if (items.length > 200)
        throw new Error("A daily card can contain at most 200 items");
    });
  }
  if (!items.length) throw new Error("The card has no plan items");
  return { day, items };
}
// Seed notes for a newly created item; existing items keep their own notes.
export function planItemNotes(item: ParsedPlanItem): string {
  const line = (t: PlanTicket) =>
    "- " +
    [t.key, t.status && `\`${t.status}\``, t.note && `— ${t.note}`]
      .filter(Boolean)
      .join(" ");
  return [
    item.note,
    item.tickets.length && `**Tickets**\n${item.tickets.map(line).join("\n")}`,
    item.related.length && `**Related**\n${item.related.map(line).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
