import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Store } from "../src/main/store";
import { PlanningStore } from "../src/main/planning-store";
import { readPlanInbox } from "../src/main/plan-inbox";
import { parseDailyPlan } from "../src/shared/planning";
const card =
  "---\ndate: 2026-10-08\n---\n\n## Coding\n- Deck\n\n## Agentic\n- Save research\n\n## Other\n- Review a document\n- Ask about deployment";
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "acd-plan-")),
    file = join(dir, "workspace.sqlite");
  let store = new Store(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
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
test("daily card parser preserves broad names, ignores checkbox completion, and rejects ambiguous or malformed cards", () => {
  const parsed = parseDailyPlan(
    card.replace("- Review a document", "- [x] Review a document"),
  );
  assert.equal(parsed.day, "2026-10-08");
  assert.deepEqual(parsed.items.at(-2), {
    name: "Review a document",
    category: "Other",
  });
  for (const bad of [
    card.replace("2026-10-08", "2026-02-31"),
    card.replace("## Other", "## Misc"),
    card.replace("- Deck", "  - Nested"),
    card.replace("date: 2026-10-08", "date: 2026-10-08\ndate: 2026-10-09"),
    card + "\n# 2026-10-09",
    card + "\nUnparsed text",
  ])
    assert.throws(() => parseDailyPlan(bad));
  assert.equal(
    parseDailyPlan("# 2026-10-08\n## Other\n- Ask a colleague").items.length,
    1,
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
    markdown: card,
    sourceName: "card.md",
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
  assert.equal(f.plans.imports()[0].markdown, card);
  f.store.command({ type: "removePlanEntry", id: item.id, day: "2026-10-08" });
  assert.equal(
    f.plans.items().find((i) => i.id === item.id)!.notes,
    "## My notes",
  );
});
test("imports are atomic, deduplicated and explicitly connect recurring work", (t) => {
  const f = fixture(t);
  f.store.command({
    type: "importDailyPlan",
    markdown: card,
    sourceName: "card.md",
    itemIds: [null, null, null, null],
  });
  f.store.command({
    type: "importDailyPlan",
    markdown: card,
    sourceName: "another.md",
    itemIds: [null, null, null, null],
  });
  assert.equal(f.plans.items().length, 4);
  const second = card.replace("2026-10-08", "2026-10-09"),
    item = f.plans.items().find((i) => i.name === "Deck")!;
  assert.throws(() =>
    f.store.command({
      type: "importDailyPlan",
      markdown: second,
      sourceName: "next.md",
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
        markdown: second,
        sourceName: "next.md",
        itemIds: [item.id, item.id, null, null],
      }),
    /same plan item/,
  );
  f.store.command({
    type: "importDailyPlan",
    markdown: second,
    sourceName: "next.md",
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
    path = join(initial.path, "card.md");
  writeFileSync(path, card);
  writeFileSync(join(initial.path, "partial.tmp"), card);
  symlinkSync(
    process.platform === "win32" ? f.dir : f.file,
    join(initial.path, "symlink.md"),
    process.platform === "win32" ? "junction" : "file",
  );
  writeFileSync(join(initial.path, "large.md"), "a".repeat(256001));
  const pending = readPlanInbox(f.dir, f.plans);
  assert.equal(pending.files.length, 3);
  assert.equal(pending.files.find((i) => i.name === "card.md")!.markdown, card);
  assert.ok(pending.files.find((i) => i.name === "symlink.md")!.error);
  assert.ok(pending.files.find((i) => i.name === "large.md")!.error);
  f.store.command({
    type: "importDailyPlan",
    markdown: card,
    sourceName: "card.md",
    itemIds: [null, null, null, null],
  });
  assert.equal(
    readPlanInbox(f.dir, f.plans).files.some((i) => i.name === "card.md"),
    false,
  );
  assert.equal(readFileSync(path, "utf8"), card);
});
test("v9 planning migration backs up once, retains existing chats, and isolates separate stores", (t) => {
  const f = fixture(t);
  f.store.command({ type: "createChat", name: "Keep chat", projectId: null });
  const before = f.store.chats();
  f.store.db.exec(
    "DROP TABLE plan_chats; DROP TABLE plan_entries; DROP TABLE plan_imports; DROP TABLE plan_items; PRAGMA user_version=9;",
  );
  f.reopen();
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 10);
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
    markdown: card,
    sourceName: "card.md",
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
