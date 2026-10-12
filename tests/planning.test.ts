import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { removeFixture } from "./fixture-cleanup";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Store } from "../src/main/store";
import { PlanningStore } from "../src/main/planning-store";
import { readPlanInbox } from "../src/main/plan-inbox";
import { parseDailyPlan, planItemNotes } from "../src/shared/planning";
import { recentUnlinkedChats, newChatActivity } from "../src/shared/new-chats";
const card =
  "date: 2026-10-08\ncoding:\n  - Deck\nagentic:\n  - Save research\nother:\n  - Review a document\n  - Ask about deployment\n";
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "acd-plan-")),
    file = join(dir, "workspace.sqlite");
  let store = new Store(file);
  t.after(() => {
    store.close();
    removeFixture(dir);
  });
  return {
    dir,
    file,
    get store() {
      return store;
    },
    get plans() {
      return new PlanningStore(store);
    },
    reopen() {
      store.close();
      store = new Store(file);
      return store;
    },
  };
}
test("New chats use local creation/event dates, ignore user edits, and exclude links on any card", (t) => {
  const f = fixture(t);
  const stamp = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
  for (const name of ["Created", "Updated", "Edited", "Archived", "Linked", "Before midnight"])
    f.store.command({ type: "createChat", name, projectId: null });
  const chats = f.store.chats();
  const chat = (name: string) => chats.find((c) => c.name === name)!;
  for (const c of chats)
    f.store.db.prepare("UPDATE chats SET createdAt=?,lastEventAt=?,updatedAt=? WHERE id=?")
      .run(stamp(11, 12), stamp(11, 23), stamp(12, 15), c.id);
  f.store.db.prepare("UPDATE chats SET createdAt=? WHERE id=?").run(stamp(12, 9), chat("Created").id);
  for (const name of ["Updated", "Archived", "Linked"])
    f.store.db.prepare("UPDATE chats SET lastEventAt=? WHERE id=?").run(stamp(12, 10), chat(name).id);
  f.store.command({ type: "updateChat", id: chat("Archived").id, patch: { archived: true } });
  f.store.command({ type: "createPlanItem", day: "2026-10-01", category: "Coding", name: "Earlier card", chatIds: [chat("Linked").id] });
  const recent = recentUnlinkedChats(f.store.chats(), f.plans.items(), "2026-10-12");
  assert.deepEqual(recent.map((c) => c.name), ["Updated", "Created"]);
  assert.equal(newChatActivity(recent[0], "2026-10-12"), "Updated");
  assert.equal(newChatActivity(recent[1], "2026-10-12"), "New");
});

test("creating a task with chats is atomic, undoable, and retains unrelated task drafts", (t) => {
  const f = fixture(t);
  f.store.command({ type: "createChat", name: "Research", projectId: null });
  const chat = f.store.chats()[0];
  f.store.command({ type: "savePlanDraft", key: "task-create", value: '{"name":"Unfinished task"}' });
  const command = { type: "createPlanItem" as const, day: "2026-10-12", category: "Coding" as const, name: "Research", chatIds: [chat.id, chat.id] };
  f.store.command(command);
  const item = f.plans.items()[0];
  assert.deepEqual(item.chatIds, [chat.id]);
  assert.deepEqual(item.automaticChatIds, []);
  assert.equal(f.plans.drafts()["task-create"], '{"name":"Unfinished task"}');
  assert.equal(f.plans.entries()[0].workedOn, false);
  const snapshot = () => ({ items: f.plans.items(), entries: f.plans.entries(), drafts: f.plans.drafts(), undoId: f.plans.undoId() });
  const before = snapshot();
  assert.throws(() => f.store.command({ ...command, chatIds: [chat.id, "00000000-0000-4000-8000-000000000000"] }));
  assert.deepEqual(snapshot(), before);
  f.store.command({ type: "undoPlanning", undoId: before.undoId! });
  assert.deepEqual(f.plans.items(), []);
  assert.equal(f.store.chats().length, 1);
  assert.equal(f.plans.drafts()["task-create"], '{"name":"Unfinished task"}');
});
test("daily card parser keeps tickets and annotations in separate fields and rejects malformed cards", () => {
  const parsed = parseDailyPlan(`
date: 2026-10-09
Coding:
  - name: CEF signing
    tickets:
      - key: thr-1118
        status: backlog
        note: CEF support in BSR
    note: Waiting on review
  - name: Test JA4 detection lab
    related: [THR-1165, THR-914]
agentic:
  - name: Continue auto sampling
    tickets:
      - { key: THR-1241, status: backlog, note: "Agent Canary, unassigned" }
      - THR-1235
other:
  - Ask a colleague
`);
  assert.equal(parsed.day, "2026-10-09");
  assert.deepEqual(parsed.items[0], {
    name: "CEF signing",
    category: "Coding",
    tickets: [{ key: "THR-1118", status: "backlog", note: "CEF support in BSR" }],
    related: [],
    note: "Waiting on review",
  });
  assert.deepEqual(
    parsed.items[1].related.map((t) => t.key),
    ["THR-1165", "THR-914"],
  );
  assert.deepEqual(parsed.items[2].tickets[1], {
    key: "THR-1235",
    status: "",
    note: "",
  });
  assert.equal(parsed.items[3].name, "Ask a colleague");
  assert.equal(
    planItemNotes(parsed.items[0]),
    "Waiting on review\n\n**Tickets**\n- THR-1118 `backlog` — CEF support in BSR",
  );
  assert.equal(
    parseDailyPlan("date: 2026-10-08\nother: [Ask]\ncoding:\n").items.length,
    1,
  );
  for (const bad of [
    card.replace("2026-10-08", "2026-02-31"),
    card.replace("other:", "misc:"),
    card.replace("coding:", "coding: Deck\nextra:"),
    card + "date: 2026-10-09\n",
    card + "coding:\n  - Again\n",
    "date: 2026-10-08\ncoding:\n  - name: A\n    tickets: [not a key]\n",
    "date: 2026-10-08\ncoding:\n  - name: A\n    tickets: [THR-1, THR-1]\n",
    "date: 2026-10-08\ncoding:\n  - name: A\n    ticket: THR-1\n",
    "date: 2026-10-08\ncoding:\n  - note: no name\n",
    "date: 2026-10-08\ncoding:\n  - &a [x]\n  - *a\n",
    "date: 2026-10-08\n",
  ])
    assert.throws(() => parseDailyPlan(bad), Error, bad);
});
test("rescheduling moves an item to another day and keeps its context", (t) => {
  const f = fixture(t);
  f.store.command({
    type: "importDailyPlan",
    card,
    sourceName: "card.yaml",
    itemIds: [null, null, null, null],
  });
  const item = f.plans.items().find((i) => i.name === "Deck")!;
  f.store.command({
    type: "updatePlanItem",
    id: item.id,
    patch: { notes: "## My notes" },
  });
  const move = (fromDay: string, day: string) => ({
    type: "reschedulePlanItem" as const,
    id: item.id,
    fromDay,
    day,
    category: "Coding" as const,
  });
  assert.throws(() => f.store.command(move("2026-10-08", "2026-10-08")), Error);
  assert.throws(() => f.store.command(move("2026-10-07", "2026-10-09")), Error);
  f.store.command(move("2026-10-08", "2026-10-09"));
  const days = f.plans
    .entries()
    .filter((e) => e.itemId === item.id)
    .map((e) => e.day);
  assert.deepEqual(days, ["2026-10-09"]);
  assert.equal(
    f.plans.items().find((i) => i.id === item.id)!.notes,
    "## My notes",
  );
});
test("planning survives provider events, carry-forward and restart without changing chat organization", (t) => {
  const f = fixture(t);
  f.store.command({ type: "createProject", name: "Broader goal" });
  const project = f.store.projects()[0];
  f.store.command({
    type: "createSource",
    name: "Local",
    provider: "claude",
    environment: "native",
  });
  const source = f.store.sources()[0];
  const event = (id: string, hook: string) => ({
    version: 1 as const,
    eventId: id,
    payload: {
      hook_event_name: hook,
      session_id: "chat",
      cwd: "/plan-test",
      prompt: "Work on deck",
    },
  });
  f.store.ingest(source.id, event("one", "UserPromptSubmit"));
  const chat = f.store.chats()[0];
  f.store.command({
    type: "importDailyPlan",
    card,
    sourceName: "card.yaml",
    itemIds: [null, null, null, null],
  });
  const item = f.plans.items().find((i) => i.name === "Deck")!;
  assert.equal(item.projectId, null);
  f.store.command({
    type: "updatePlanItem",
    id: item.id,
    patch: { notes: "## My notes", projectId: project.id },
  });
  f.store.command({
    type: "setPlanChats",
    id: item.id,
    chatIds: [chat.id, chat.id],
  });
  f.store.command({
    type: "setPlanWorkedOn",
    id: item.id,
    day: "2026-10-08",
    workedOn: true,
  });
  f.store.command({
    type: "schedulePlanItem",
    id: item.id,
    day: "2026-10-09",
    category: "Coding",
  });
  f.store.command({
    type: "schedulePlanItem",
    id: item.id,
    day: "2026-10-09",
    category: "Coding",
  });
  f.store.ingest(source.id, event("two", "Stop"));
  f.reopen();
  assert.deepEqual(
    f.plans.items().find((i) => i.id === item.id),
    {
      ...item,
      notes: "## My notes",
      projectId: project.id,
      chatIds: [chat.id],
      updatedAt: f.plans.items().find((i) => i.id === item.id)!.updatedAt,
    },
  );
  assert.equal(f.store.chat(chat.id).projectId, chat.projectId);
  assert.equal(f.store.chat(chat.id).notes, "");
  const entries = f.plans.entries().filter((e) => e.itemId === item.id);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].workedOn, true);
  assert.equal(entries[1].workedOn, false);
  assert.equal(f.plans.imports()[0].card, card);
  f.store.command({ type: "removePlanEntry", id: item.id, day: "2026-10-08" });
  assert.equal(
    f.plans.items().find((i) => i.id === item.id)!.notes,
    "## My notes",
  );
  f.store.command({ type: "deletePlanItem", id: item.id });
  assert.equal(f.plans.items().some((i) => i.id === item.id), false);
  assert.equal(f.plans.entries().some((e) => e.itemId === item.id), false);
  assert.equal(f.store.chat(chat.id).id, chat.id);
  assert.throws(() => f.store.command({ type: "deletePlanItem", id: item.id }));
  assert.deepEqual(f.store.db.pragma("foreign_key_check"), []);
});
test("imports are atomic, deduplicated and explicitly connect recurring work", (t) => {
  const f = fixture(t);
  f.store.command({
    type: "importDailyPlan",
    card,
    sourceName: "card.yaml",
    itemIds: [null, null, null, null],
  });
  f.store.command({
    type: "importDailyPlan",
    card,
    sourceName: "another.yaml",
    itemIds: [null, null, null, null],
  });
  assert.equal(f.plans.items().length, 4);
  const second = card.replace("2026-10-08", "2026-10-09"),
    item = f.plans.items().find((i) => i.name === "Deck")!;
  assert.throws(() =>
    f.store.command({
      type: "importDailyPlan",
      card: second,
      sourceName: "next.yaml",
      itemIds: [item.id, null, "missing", null],
    }),
  );
  assert.equal(f.plans.items().length, 4);
  assert.equal(f.plans.entries().length, 4);
  assert.equal(f.plans.imports().length, 1);
  assert.throws(
    () =>
      f.store.command({
        type: "importDailyPlan",
        card: second,
        sourceName: "next.yaml",
        itemIds: [item.id, item.id, null, null],
      }),
    /same plan item/,
  );
  f.store.command({
    type: "importDailyPlan",
    card: second,
    sourceName: "next.yaml",
    itemIds: [item.id, null, null, null],
  });
  assert.equal(f.plans.items().length, 7);
  assert.equal(f.plans.entries().filter((e) => e.itemId === item.id).length, 2);
  assert.throws(() =>
    f.store.command({
      type: "setPlanWorkedOn",
      id: item.id,
      day: "2026-02-31",
      workedOn: true,
    }),
  );
  assert.throws(() =>
    f.store.command({
      type: "setPlanChats",
      id: item.id,
      chatIds: ["missing"],
    }),
  );
  assert.deepEqual(f.store.db.pragma("foreign_key_check"), []);
});
test("plan inbox preserves files, excludes imported duplicates, rejects symlinks and bounds large cards", (t) => {
  const f = fixture(t);
  const initial = readPlanInbox(f.dir, f.plans),
    path = join(initial.path, "card.yaml");
  writeFileSync(path, card);
  writeFileSync(join(initial.path, "partial.tmp"), card);
  // A separate target keeps the Windows junction from pointing at its own ancestor.
  const target = join(f.dir, "link-target");
  mkdirSync(target);
  symlinkSync(
    process.platform === "win32" ? target : f.file,
    join(initial.path, "symlink.yaml"),
    process.platform === "win32" ? "junction" : "file",
  );
  writeFileSync(join(initial.path, "large.yaml"), "a".repeat(256001));
  const pending = readPlanInbox(f.dir, f.plans);
  assert.equal(pending.files.length, 3);
  assert.equal(pending.files.find((i) => i.name === "card.yaml")!.card, card);
  assert.ok(pending.files.find((i) => i.name === "symlink.yaml")!.error);
  assert.ok(pending.files.find((i) => i.name === "large.yaml")!.error);
  f.store.command({
    type: "importDailyPlan",
    card,
    sourceName: "card.yaml",
    itemIds: [null, null, null, null],
  });
  assert.equal(
    readPlanInbox(f.dir, f.plans).files.some((i) => i.name === "card.yaml"),
    false,
  );
  assert.equal(readFileSync(path, "utf8"), card);
});
test("v9 planning migration backs up once, retains existing chats, and isolates separate stores", (t) => {
  const f = fixture(t);
  f.store.command({ type: "createChat", name: "Keep chat", projectId: null });
  const before = f.store.chats();
  f.store.db.exec(
    "DROP TABLE matching_measurements; DROP TABLE matching_feedback; DROP TABLE ai_link_dismissals; DROP TABLE ai_match_attempts; DROP TABLE plan_wrapups; DROP TABLE plan_drafts; DROP TABLE plan_undo; DROP TABLE chat_rounds; DROP TABLE plan_chats; DROP TABLE plan_entries; DROP TABLE plan_imports; DROP TABLE plan_items; PRAGMA user_version=9;",
  );
  f.reopen();
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 13);
  assert.deepEqual(f.store.chats(), before);
  const backups = readdirSync(f.dir).filter((n) => /\.bak-\d+$/.test(n));
  assert.equal(backups.length, 1);
  const backup = new Database(join(f.dir, backups[0]), { readonly: true });
  try {
    assert.equal(backup.pragma("user_version", { simple: true }), 9);
  } finally {
    backup.close();
  }
  f.store.command({
    type: "importDailyPlan",
    card,
    sourceName: "card.yaml",
    itemIds: [null, null, null, null],
  });
  f.reopen();
  assert.equal(
    readdirSync(f.dir).filter((n) => /\.bak-\d+$/.test(n)).length,
    1,
  );
  const demo = new Store(join(f.dir, "demo", "workspace.sqlite"));
  try {
    assert.equal(new PlanningStore(demo).items().length, 0);
  } finally {
    demo.close();
  }
});
