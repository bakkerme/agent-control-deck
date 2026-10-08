import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store";
import type { Command } from "../shared/types";
import {
  parseDailyPlan,
  type PlanEntry,
  type PlanImport,
  type PlanItem,
} from "../shared/planning";
export const planDigest = (markdown: string) =>
  createHash("sha256").update(markdown).digest("hex");
export class PlanningStore {
  constructor(private store: Store) {}
  items(): PlanItem[] {
    const rows = this.store.db
      .prepare("SELECT * FROM plan_items ORDER BY createdAt,id")
      .all() as Omit<PlanItem, "chatIds">[];
    const links = this.store.db
      .prepare("SELECT * FROM plan_chats ORDER BY chatId")
      .all() as { itemId: string; chatId: string }[];
    return rows.map((i) => ({
      ...i,
      chatIds: links.filter((l) => l.itemId === i.id).map((l) => l.chatId),
    }));
  }
  entries(): PlanEntry[] {
    return (
      this.store.db
        .prepare("SELECT * FROM plan_entries ORDER BY day,position,itemId")
        .all() as PlanEntry[]
    ).map((e) => ({ ...e, workedOn: !!e.workedOn }));
  }
  imports(): PlanImport[] {
    return this.store.db
      .prepare("SELECT * FROM plan_imports ORDER BY importedAt,id")
      .all() as PlanImport[];
  }
  private requireItem(id: string): void {
    if (!this.store.db.prepare("SELECT id FROM plan_items WHERE id=?").get(id))
      throw new Error("Choose an existing plan item");
  }
  private schedule(id: string, day: string, category: string): void {
    this.requireItem(id);
    const row = this.store.db
      .prepare(
        "SELECT COALESCE(MAX(position),-1)+1 AS position FROM plan_entries WHERE day=?",
      )
      .get(day) as { position: number };
    this.store.db
      .prepare(
        "INSERT INTO plan_entries (day,itemId,category,position) VALUES (?,?,?,?) ON CONFLICT(day,itemId) DO UPDATE SET category=excluded.category",
      )
      .run(day, id, category, row.position);
  }
  private create(name: string): string {
    const id = randomUUID(),
      time = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT INTO plan_items (id,name,createdAt,updatedAt) VALUES (?,?,?,?)",
      )
      .run(id, name, time, time);
    return id;
  }
  command(c: Command): boolean {
    const db = this.store.db;
    switch (c.type) {
      case "createPlanItem":
        db.transaction(() =>
          this.schedule(this.create(c.name), c.day, c.category),
        )();
        break;
      case "updatePlanItem": {
        this.requireItem(c.id);
        if (
          c.patch.projectId &&
          !this.store.projects().some((p) => p.id === c.patch.projectId)
        )
          throw new Error("Choose an existing project");
        const entries = Object.entries(c.patch).filter(
          ([, v]) => v !== undefined,
        );
        if (entries.length)
          db.prepare(
            `UPDATE plan_items SET ${entries.map(([k]) => `${k}=?`).join(",")},updatedAt=? WHERE id=?`,
          ).run(...entries.map(([, v]) => v), new Date().toISOString(), c.id);
        break;
      }
      case "schedulePlanItem":
        db.transaction(() => this.schedule(c.id, c.day, c.category))();
        break;
      case "setPlanWorkedOn": {
        this.requireItem(c.id);
        if (
          !db
            .prepare(
              "UPDATE plan_entries SET workedOn=? WHERE day=? AND itemId=?",
            )
            .run(Number(c.workedOn), c.day, c.id).changes
        )
          throw new Error("Schedule this item on that day first");
        break;
      }
      case "removePlanEntry":
        this.requireItem(c.id);
        db.prepare("DELETE FROM plan_entries WHERE day=? AND itemId=?").run(
          c.day,
          c.id,
        );
        break;
      case "setPlanChats":
        db.transaction(() => {
          this.requireItem(c.id);
          for (const id of c.chatIds) this.store.chat(id);
          db.prepare("DELETE FROM plan_chats WHERE itemId=?").run(c.id);
          for (const id of new Set(c.chatIds))
            db.prepare("INSERT INTO plan_chats VALUES (?,?)").run(c.id, id);
        })();
        break;
      case "importDailyPlan":
        db.transaction(() => {
          const parsed = parseDailyPlan(c.markdown),
            digest = planDigest(c.markdown);
          if (c.itemIds.length !== parsed.items.length)
            throw new Error("Review each imported item before importing");
          if (db.prepare("SELECT id FROM plan_imports WHERE id=?").get(digest))
            return;
          const existingIds = c.itemIds.filter(
            (id): id is string => id !== null,
          );
          if (new Set(existingIds).size !== existingIds.length)
            throw new Error(
              "Two card entries cannot connect to the same plan item on one day",
            );
          for (const id of existingIds) this.requireItem(id);
          parsed.items.forEach((row, index) =>
            this.schedule(
              c.itemIds[index] ?? this.create(row.name),
              parsed.day,
              row.category,
            ),
          );
          db.prepare("INSERT INTO plan_imports VALUES (?,?,?,?,?)").run(
            digest,
            parsed.day,
            c.sourceName,
            c.markdown,
            new Date().toISOString(),
          );
        })();
        break;
      default:
        return false;
    }
    return true;
  }
}
