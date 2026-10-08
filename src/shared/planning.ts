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
  markdown: string;
  importedAt: string;
}
export interface PlanInboxFile {
  name: string;
  markdown: string;
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
export interface ParsedPlan {
  day: string;
  items: { name: string; category: PlanCategory }[];
}
// Deliberately small Markdown contract: one dated card, three headings, flat bullets.
// Project relationships, chat links, and progress always remain user decisions.
export function parseDailyPlan(markdown: string): ParsedPlan {
  if (markdown.length > 100000)
    throw new Error("Card exceeds 100,000 characters");
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const header = text.match(/^#\s+(\d{4}-\d{2}-\d{2})\s*$/m);
  const dates =
    frontmatter?.[1].match(/^date:\s*\d{4}-\d{2}-\d{2}\s*$/gm) ?? [];
  if (dates.length > 1) throw new Error("Use one date per card");
  const day = dates[0]?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? header?.[1] ?? "";
  if (!validPlanDay(day))
    throw new Error(
      "Add a valid date: YYYY-MM-DD in frontmatter, or use # YYYY-MM-DD",
    );
  if (header && header[1] !== day)
    throw new Error("The card heading and frontmatter dates disagree");
  let category: PlanCategory | null = null;
  const items: ParsedPlan["items"] = [];
  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  for (const line of body.split("\n")) {
    if (!line.trim() || /^#\s+/.test(line)) continue;
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      category =
        planCategories.find(
          (c) => c.toLowerCase() === heading[1].toLowerCase(),
        ) ?? null;
      if (!category)
        throw new Error(
          `Unknown category: ${heading[1]}. Use Coding, Agentic, or Other.`,
        );
      continue;
    }
    const bullet = line.match(/^[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/);
    if (!bullet || !category)
      throw new Error(
        "Use flat bullet items under ## Coding, ## Agentic, or ## Other",
      );
    if (bullet[1].length > 200)
      throw new Error("Plan item names must be at most 200 characters");
    items.push({ name: bullet[1], category });
    if (items.length > 200)
      throw new Error("A daily card can contain at most 200 items");
  }
  if (!items.length) throw new Error("The card has no plan items");
  return { day, items };
}
