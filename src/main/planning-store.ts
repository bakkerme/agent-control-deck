import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store";
import type { Command } from "../shared/types";
import {
  parseDailyPlan,
  type PlanEntry,
  type PlanImport,
  type PlanItem,
  type PlanTicket,
} from "../shared/planning";
export const planDigest = (card: string) =>
  createHash("sha256").update(card).digest("hex");
const tables = [
  "plan_items",
  "plan_entries",
  "plan_chats",
  "plan_imports",
  "plan_wrapups",
] as const;
const commands = new Set([
  "createPlanItem",
  "updatePlanItem",
  "updatePlanEntry",
  "reorderPlanEntry",
  "setDayWrapup",
  "setPlanChats",
  "schedulePlanItem",
  "reschedulePlanItem",
  "removePlanEntry",
  "deletePlanItem",
  "setPlanWorkedOn",
  "importDailyPlan",
]);
export class PlanningStore {
  constructor(private store: Store) {}
  items(): PlanItem[] {
    const rows = this.store.db
      .prepare("SELECT * FROM plan_items ORDER BY createdAt,rowid")
      .all() as (Omit<
      PlanItem,
      "chatIds" | "tickets" | "links" | "hiddenLinks" | "categoryOverrides"
    > & {
      tickets: string;
      links: string;
      hiddenLinks: string;
      categoryOverrides: string;
    })[];
    const links = this.store.db
      .prepare("SELECT * FROM plan_chats ORDER BY chatId")
      .all() as { itemId: string; chatId: string }[];
    return rows.map((i) => ({
      ...i,
      tickets: JSON.parse(i.tickets),
      links: JSON.parse(i.links),
      hiddenLinks: JSON.parse(i.hiddenLinks),
      categoryOverrides: JSON.parse(i.categoryOverrides),
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
      .prepare(
        "SELECT id,day,sourceName,markdown AS card,importedAt FROM plan_imports ORDER BY importedAt,id",
      )
      .all() as PlanImport[];
  }
  wrapups(): Record<string, string> {
    return Object.fromEntries(
      (
        this.store.db
          .prepare("SELECT * FROM plan_wrapups ORDER BY day")
          .all() as { day: string; notes: string }[]
      ).map((row) => [row.day, row.notes]),
    );
  }
  drafts(): Record<string, string> {
    return Object.fromEntries(
      (
        this.store.db.prepare("SELECT * FROM plan_drafts").all() as {
          key: string;
          value: string;
        }[]
      ).map((row) => [row.key, row.value]),
    );
  }
  undoId(): string | null {
    return (
      (
        this.store.db.prepare("SELECT id FROM plan_undo").get() as
          | { id: string }
          | undefined
      )?.id ?? null
    );
  }
  private requireItem(id: string): PlanItem {
    const item = this.items().find((i) => i.id === id);
    if (!item) throw new Error("Choose an existing task");
    return item;
  }
  private schedule(
    id: string,
    day: string,
    category: string,
    name?: string,
    note?: string,
  ): void {
    const item = this.requireItem(id);
    const row = this.store.db
      .prepare(
        "SELECT COALESCE(MAX(position),-1)+1 AS position FROM plan_entries WHERE day=?",
      )
      .get(day) as { position: number };
    this.store.db
      .prepare(
        "INSERT INTO plan_entries (day,itemId,category,position,name,note) VALUES (?,?,?,?,?,?) ON CONFLICT(day,itemId) DO UPDATE SET category=excluded.category",
      )
      .run(day, id, category, row.position, name ?? item.name, note ?? "");
  }
  private create(name: string, notes = "", tickets: PlanTicket[] = []): string {
    if (tickets.length > 100)
      throw new Error("A task can have at most 100 linked tickets");
    const id = randomUUID(),
      time = new Date().toISOString();
    this.store.db
      .prepare(
        "INSERT INTO plan_items (id,name,notes,tickets,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
      )
      .run(id, name, notes, JSON.stringify(tickets), time, time);
    return id;
  }
  private state(): string {
    return JSON.stringify(
      Object.fromEntries(
        tables.map((table) => [
          table,
          this.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
      ),
    );
  }
  command(c: Command): boolean {
    const db = this.store.db;
    if (c.type === "savePlanDraft") {
      if (c.value !== null && /^(notes|tickets|links|categories):/.test(c.key))
        this.requireItem(c.key.slice(c.key.indexOf(":") + 1));
      if (c.value === null)
        db.prepare("DELETE FROM plan_drafts WHERE key=?").run(c.key);
      else
        db.prepare(
          "INSERT INTO plan_drafts VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(c.key, c.value);
      return true;
    }
    if (c.type === "undoPlanning") {
      db.transaction(() => {
        const undo = db
          .prepare("SELECT * FROM plan_undo WHERE id=?")
          .get(c.undoId) as
          | { beforeState: string; afterDigest: string }
          | undefined;
        if (!undo || undo.afterDigest !== planDigest(this.state()))
          throw new Error(
            "The plan changed after this action; Undo is no longer available",
          );
        const previous = JSON.parse(undo.beforeState) as Record<
          string,
          Record<string, unknown>[]
        >;
        for (const table of [
          "plan_chats",
          "plan_entries",
          "plan_items",
          "plan_imports",
          "plan_wrapups",
        ])
          db.prepare(`DELETE FROM ${table}`).run();
        for (const table of tables)
          for (const row of previous[table]) {
            const columns = Object.keys(row);
            db.prepare(
              `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            ).run(...Object.values(row));
          }
        db.prepare("DELETE FROM plan_undo").run();
      })();
      return true;
    }
    if (!commands.has(c.type)) return false;
    db.transaction(() => {
      const before = this.state();
      switch (c.type) {
        case "createPlanItem":
          this.schedule(
            this.create(c.name, c.notes, c.tickets),
            c.day,
            c.category,
          );
          db.prepare("DELETE FROM plan_drafts WHERE key='task-create'").run();
          break;
        case "updatePlanItem": {
          this.requireItem(c.id);
          if (
            c.patch.projectId &&
            !this.store.projects().some((p) => p.id === c.patch.projectId)
          )
            throw new Error("Choose an existing project");
          const entries = Object.entries(c.patch).filter(
              ([, value]) => value !== undefined,
            ),
            encoded = new Set([
              "tickets",
              "links",
              "hiddenLinks",
              "categoryOverrides",
            ]);
          if (entries.length)
            db.prepare(
              `UPDATE plan_items SET ${entries.map(([key]) => `${key}=?`).join(",")},updatedAt=? WHERE id=?`,
            ).run(
              ...entries.map(([key, value]) =>
                encoded.has(key) ? JSON.stringify(value) : value,
              ),
              new Date().toISOString(),
              c.id,
            );
          if (c.patch.notes !== undefined)
            db.prepare("DELETE FROM plan_drafts WHERE key=?").run(
              `notes:${c.id}`,
            );
          break;
        }
        case "updatePlanEntry": {
          const old = this.entries().find(
            (e) => e.itemId === c.id && e.day === c.day,
          );
          if (!old) throw new Error("This task is not on that day");
          db.prepare(
            "UPDATE plan_entries SET name=?,category=? WHERE itemId=? AND day=?",
          ).run(c.name ?? old.name, c.category ?? old.category, c.id, c.day);
          if (c.name !== undefined)
            db.prepare(
              "UPDATE plan_items SET name=?,updatedAt=? WHERE id=?",
            ).run(c.name, new Date().toISOString(), c.id);
          break;
        }
        case "reorderPlanEntry": {
          if (!this.entries().some((e) => e.itemId === c.id && e.day === c.day))
            throw new Error("This task is not on that day");
          const peers = this.entries()
              .filter(
                (e) =>
                  e.day === c.day &&
                  e.category === c.category &&
                  e.itemId !== c.id,
              )
              .map((e) => e.itemId),
            index = c.beforeId ? peers.indexOf(c.beforeId) : peers.length;
          if (index < 0)
            throw new Error("The target task moved; try dragging again");
          peers.splice(index, 0, c.id);
          peers.forEach((id, position) =>
            db
              .prepare(
                "UPDATE plan_entries SET category=?,position=? WHERE day=? AND itemId=?",
              )
              .run(c.category, position, c.day, id),
          );
          break;
        }
        case "setDayWrapup":
          db.prepare(
            "INSERT INTO plan_wrapups VALUES (?,?) ON CONFLICT(day) DO UPDATE SET notes=excluded.notes",
          ).run(c.day, c.notes);
          db.prepare("DELETE FROM plan_drafts WHERE key=?").run(
            `wrap:${c.day}`,
          );
          break;
        case "schedulePlanItem":
          this.schedule(c.id, c.day, c.category, c.name);
          if (c.name !== undefined)
            db.prepare(
              "UPDATE plan_items SET name=?,updatedAt=? WHERE id=?",
            ).run(c.name, new Date().toISOString(), c.id);
          break;
        case "reschedulePlanItem": {
          const old = this.entries().find(
            (e) => e.itemId === c.id && e.day === c.fromDay,
          );
          if (c.day === c.fromDay) throw new Error("Choose a different day");
          if (!old) throw new Error("This item is not scheduled on that day");
          if (this.entries().some((e) => e.itemId === c.id && e.day === c.day))
            throw new Error("This task is already on the destination day");
          this.schedule(c.id, c.day, c.category, old.name, old.note);
          db.prepare("DELETE FROM plan_entries WHERE day=? AND itemId=?").run(
            c.fromDay,
            c.id,
          );
          break;
        }
        case "setPlanWorkedOn":
          this.requireItem(c.id);
          if (
            !db
              .prepare(
                "UPDATE plan_entries SET workedOn=? WHERE day=? AND itemId=?",
              )
              .run(Number(c.workedOn), c.day, c.id).changes
          )
            throw new Error("Schedule this task on that day first");
          break;
        case "removePlanEntry": {
          this.requireItem(c.id);
          const days = this.entries().filter((e) => e.itemId === c.id);
          if (!days.some((e) => e.day === c.day))
            throw new Error("This task is no longer on that day");
          if (days.length === 1 && !c.confirmLast)
            throw new Error("Confirm removing this task's final card");
          db.prepare("DELETE FROM plan_entries WHERE day=? AND itemId=?").run(
            c.day,
            c.id,
          );
          if (days.length === 1) {
            db.prepare("DELETE FROM plan_chats WHERE itemId=?").run(c.id);
            db.prepare("DELETE FROM plan_items WHERE id=?").run(c.id);
            for (const prefix of ["notes", "tickets", "links", "categories"])
              db.prepare("DELETE FROM plan_drafts WHERE key=?").run(
                `${prefix}:${c.id}`,
              );
          }
          break;
        }
        case "deletePlanItem":
          this.requireItem(c.id);
          db.prepare("DELETE FROM plan_chats WHERE itemId=?").run(c.id);
          db.prepare("DELETE FROM plan_entries WHERE itemId=?").run(c.id);
          db.prepare("DELETE FROM plan_items WHERE id=?").run(c.id);
          for (const prefix of ["notes", "tickets", "links", "categories"])
            db.prepare("DELETE FROM plan_drafts WHERE key=?").run(
              `${prefix}:${c.id}`,
            );
          break;
        case "setPlanChats":
          this.requireItem(c.id);
          for (const id of c.chatIds) this.store.chat(id);
          db.prepare("DELETE FROM plan_chats WHERE itemId=?").run(c.id);
          for (const id of new Set(c.chatIds))
            db.prepare("INSERT INTO plan_chats VALUES (?,?)").run(c.id, id);
          break;
        case "importDailyPlan": {
          const parsed = parseDailyPlan(c.card),
            digest = planDigest(c.card);
          if (
            c.itemIds.length !== parsed.items.length ||
            (c.names && c.names.length !== parsed.items.length)
          )
            throw new Error("Review each imported task before importing");
          if (db.prepare("SELECT id FROM plan_imports WHERE id=?").get(digest))
            break;
          const existingIds = c.itemIds.filter(
            (id): id is string => id !== null,
          );
          if (new Set(existingIds).size !== existingIds.length)
            throw new Error(
              "Two card entries cannot connect to the same plan item on one day",
            );
          for (const id of existingIds) this.requireItem(id);
          parsed.items.forEach((row, index) => {
            const name = c.names?.[index] ?? row.name,
              tickets = [...row.tickets, ...row.related].filter(
                (ticket, index, all) =>
                  all.findIndex((other) => other.key === ticket.key) === index,
              ),
              id = c.itemIds[index] ?? this.create(name, row.note, tickets);
            this.schedule(id, parsed.day, row.category, name, row.note);
            db.prepare(
              "UPDATE plan_entries SET name=?,note=? WHERE day=? AND itemId=?",
            ).run(name, row.note, parsed.day, id);
            db.prepare(
              "UPDATE plan_items SET name=?,updatedAt=? WHERE id=?",
            ).run(name, new Date().toISOString(), id);
            if (c.itemIds[index]) {
              const existing = this.requireItem(id).tickets;
              const merged = [
                ...existing,
                ...tickets.filter(
                  (ticket) => !existing.some((old) => old.key === ticket.key),
                ),
              ];
              if (merged.length > 100)
                throw new Error("A task can have at most 100 linked tickets");
              db.prepare("UPDATE plan_items SET tickets=? WHERE id=?").run(
                JSON.stringify(merged),
                id,
              );
            }
          });
          db.prepare("INSERT INTO plan_imports VALUES (?,?,?,?,?)").run(
            digest,
            parsed.day,
            c.sourceName,
            c.card,
            new Date().toISOString(),
          );
          db.prepare("DELETE FROM plan_drafts WHERE key='card-review'").run();
          break;
        }
      }
      const after = this.state();
      if (before !== after) {
        db.prepare("DELETE FROM plan_undo").run();
        db.prepare("INSERT INTO plan_undo VALUES (?,?,?)").run(
          randomUUID(),
          before,
          planDigest(after),
        );
      }
    })();
    return true;
  }
}
