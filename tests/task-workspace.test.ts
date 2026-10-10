import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { PlanningStore } from "../src/main/planning-store";
import { parseDailyPlan, nextBusinessDay } from "../src/shared/planning";
import { removeFixture } from "./fixture-cleanup";
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "acd-task-")),
    file = join(dir, "workspace.sqlite");
  let store = new Store(file);
  t.after(() => {
    store.close();
    removeFixture(dir);
  });
  return {
    dir,
    get store() {
      return store;
    },
    get plans() {
      return new PlanningStore(store);
    },
    reopen() {
      store.close();
      store = new Store(file);
    },
  };
}
const card =
  "date: 2026-10-09\ncoding:\n  - name: Deck\n    tickets: [DECK-42]\n    note: Original card annotation\n";
test("continuation accepts new wording while freezing earlier titles and preserving task context", (t) => {
  const f = fixture(t);
  f.store.command({
    type: "importDailyPlan",
    card,
    sourceName: "card.yaml",
    itemIds: [null],
  });
  const item = f.plans.items()[0];
  f.store.command({
    type: "updatePlanItem",
    id: item.id,
    patch: {
      notes: "User notes",
      links: [
        {
          url: "https://example.com/design",
          label: "Design",
          category: "References",
        },
      ],
    },
  });
  f.store.command({
    type: "setPlanWorkedOn",
    id: item.id,
    day: "2026-10-09",
    workedOn: true,
  });
  f.store.command({
    type: "importDailyPlan",
    card: "# 2026-10-12\n## Coding\n- Resolve design questions\n  New daily annotation",
    sourceName: "Claude.md",
    itemIds: [item.id],
    names: ["Resolve remaining questions"],
  });
  f.store.command({
    type: "updatePlanEntry",
    id: item.id,
    day: "2026-10-12",
    name: "Finish the design",
  });
  f.reopen();
  const after = f.plans.items()[0];
  assert.equal(after.notes, "User notes");
  assert.equal(after.tickets[0].key, "DECK-42");
  assert.equal(after.links[0].category, "References");
  assert.equal(after.name, "Finish the design");
  assert.deepEqual(
    f.plans.entries().map((e) => [e.name, e.note, e.workedOn]),
    [
      ["Deck", "Original card annotation", true],
      ["Finish the design", "New daily annotation", false],
    ],
  );
});
test("final-card deletion is confirmed atomically and Undo restores context without rewinding agents", (t) => {
  const f = fixture(t);
  f.store.command({
    type: "createSource",
    name: "Claude",
    provider: "claude",
    environment: "native",
  });
  const source = f.store.sources()[0];
  const emit = (
    eventId: string,
    event: string,
    extra: Record<string, unknown> = {},
  ) =>
    f.store.ingest(source.id, {
      version: 1,
      eventId,
      payload: {
        hook_event_name: event,
        session_id: "task",
        prompt: "Start work",
        ...extra,
      },
    });
  emit("one", "UserPromptSubmit");
  const chat = f.store.chats()[0];
  f.store.command({
    type: "importDailyPlan",
    card,
    sourceName: "card.yaml",
    itemIds: [null],
  });
  const item = f.plans.items()[0];
  f.store.command({ type: "setPlanChats", id: item.id, chatIds: [chat.id] });
  f.store.command({
    type: "savePlanDraft",
    key: `notes:${item.id}`,
    value: "Unsaved notes",
  });
  assert.throws(
    () =>
      f.store.command({
        type: "removePlanEntry",
        id: item.id,
        day: "2026-10-09",
      }),
    /final card/,
  );
  assert.equal(f.plans.items().length, 1);
  f.store.command({
    type: "removePlanEntry",
    id: item.id,
    day: "2026-10-09",
    confirmLast: true,
  });
  const undo = f.plans.undoId()!;
  assert.equal(f.plans.items().length, 0);
  emit("two", "Stop", {
    last_assistant_message: "Agent finished independently",
  });
  f.store.command({ type: "undoPlanning", undoId: undo });
  assert.deepEqual(f.plans.items()[0], { ...item, chatIds: [chat.id] });
  assert.equal(
    f.store.chat(chat.id).latestRound?.response,
    "Agent finished independently",
  );
  assert.deepEqual(f.store.db.pragma("foreign_key_check"), []);
  assert.throws(
    () => f.store.command({ type: "undoPlanning", undoId: undo }),
    /no longer available/,
  );
});
test("moves and drag ordering retain daily history, reset the moved done mark and reject occupied destinations", (t) => {
  const f = fixture(t);
  f.store.command({
    type: "importDailyPlan",
    card,
    sourceName: "a",
    itemIds: [null],
  });
  const item = f.plans.items()[0];
  f.store.command({
    type: "createPlanItem",
    day: "2026-10-09",
    name: "Other",
    category: "Other",
  });
  const other = f.plans.items().find((i) => i.name === "Other")!;
  f.store.command({
    type: "reorderPlanEntry",
    id: item.id,
    day: "2026-10-09",
    category: "Other",
    beforeId: other.id,
  });
  assert.deepEqual(
    f.plans.entries().map((e) => e.itemId),
    [item.id, other.id],
  );
  f.store.command({
    type: "setPlanWorkedOn",
    id: item.id,
    day: "2026-10-09",
    workedOn: true,
  });
  f.store.command({
    type: "reschedulePlanItem",
    id: item.id,
    fromDay: "2026-10-09",
    day: "2026-10-12",
    category: "Coding",
  });
  const moved = f.plans.entries().find((e) => e.itemId === item.id)!;
  assert.equal(moved.workedOn, false);
  assert.equal(moved.name, "Deck");
  assert.equal(moved.note, "Original card annotation");
  f.store.command({
    type: "schedulePlanItem",
    id: item.id,
    day: "2026-10-13",
    category: "Coding",
    name: "Continue Deck",
  });
  assert.throws(
    () =>
      f.store.command({
        type: "reschedulePlanItem",
        id: item.id,
        fromDay: "2026-10-12",
        day: "2026-10-13",
        category: "Other",
      }),
    /already/,
  );
  assert.equal(f.plans.entries().filter((e) => e.itemId === item.id).length, 2);
  assert.equal(nextBusinessDay("2026-10-09"), "2026-10-12");
  assert.equal(nextBusinessDay("2026-10-09", 3), "2026-10-14");
  assert.equal(nextBusinessDay("2026-10-10", 5), "2026-10-16");
});
test("wrap-ups and draft reviews survive restart; unsafe task references are rejected", (t) => {
  const f = fixture(t);
  f.store.command({
    type: "setDayWrapup",
    day: "2026-10-09",
    notes: "Review both card sides",
  });
  f.store.command({
    type: "savePlanDraft",
    key: "card-review",
    value: JSON.stringify({
      card,
      names: ["Deck"],
      itemIds: [null],
      reviewing: true,
    }),
  });
  f.store.command({
    type: "createPlanItem",
    day: "2026-10-12",
    name: "Task",
    category: "Coding",
    tickets: [{ key: "DECK-42", status: "", note: "" }],
    notes: "Explicit notes",
  });
  const item = f.plans.items()[0];
  const invalid = (url: string) => ({
    type: "updatePlanItem" as const,
    id: item.id,
    patch: { links: [{ url, label: "Bad", category: "Other" }] },
  });
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/a",
    "https://user:secret@example.com/",
  ])
    assert.throws(() => f.store.command(invalid(url)));
  f.reopen();
  assert.equal(f.plans.wrapups()["2026-10-09"], "Review both card sides");
  assert.equal(JSON.parse(f.plans.drafts()["card-review"]).reviewing, true);
  assert.equal(f.plans.items()[0].notes, "Explicit notes");
  assert.deepEqual(f.plans.items()[0].links, []);
});
test("latest rounds retain full observed requests, reject stale and child output, and distinguish unknown requests", (t) => {
  const f = fixture(t);
  f.store.command({
    type: "createSource",
    name: "Claude",
    provider: "claude",
    environment: "native",
  });
  const source = f.store.sources()[0],
    base = Date.now() - 10000;
  const emit = (
    eventId: string,
    event: string,
    offset: number,
    extra: Record<string, unknown> = {},
  ) =>
    f.store.ingest(source.id, {
      version: 1,
      eventId,
      observedAt: new Date(base + offset).toISOString(),
      payload: { hook_event_name: event, session_id: "round", ...extra },
    });
  emit("one", "UserPromptSubmit", 0, { prompt: "Prompt with full context" });
  const chat = f.store.chats()[0],
    request = "Long request " + "x".repeat(600) + " exact question at the end";
  emit("two", "Notification", 100, {
    notification_type: "elicitation_dialog",
    message: request,
  });
  assert.equal(f.store.chat(chat.id).latestRound?.request, request);
  assert.equal(f.store.chat(chat.id).latestRound?.requestKind, "question");
  emit("stale", "Stop", 50, { last_assistant_message: "Old response" });
  assert.equal(f.store.chat(chat.id).latestRound?.request, request);
  emit("child", "SubagentStop", 200, {
    agent_id: "worker",
    last_assistant_message: "Child output",
  });
  assert.equal(f.store.chat(chat.id).latestRound?.response, "");
  emit("resume", "PostToolUse", 300);
  assert.equal(f.store.chat(chat.id).latestRound?.request, "");
  emit("approve", "Notification", 400, {
    notification_type: "permission_prompt",
    message: "Allow report access?",
  });
  assert.equal(f.store.chat(chat.id).latestRound?.requestKind, "approval");
  emit("response", "Stop", 500, { last_assistant_message: "a".repeat(31000) });
  assert.equal(f.store.chat(chat.id).latestRound?.response.length, 30000);
  assert.equal(f.store.chat(chat.id).latestRound?.truncated, true);
  emit("new", "UserPromptSubmit", 600, { prompt: "New round" });
  assert.equal(f.store.chat(chat.id).latestRound?.response, "");
  assert.equal(f.store.chat(chat.id).latestRound?.truncated, false);
  f.reopen();
  assert.equal(f.store.chat(chat.id).latestRound?.prompt, "New round");
});
test("v10 migration preserves legacy records, backs up once and recovers only explicit import tickets", (t) => {
  const f = fixture(t);
  f.store.command({ type: "createProject", name: "Legacy custom grouping" });
  f.store.command({
    type: "createChat",
    name: "Keep chat",
    projectId: f.store.projects()[0].id,
  });
  f.store.command({
    type: "importDailyPlan",
    card,
    sourceName: "Original YAML",
    itemIds: [null],
  });
  const item = f.plans.items()[0];
  f.store.command({
    type: "updatePlanItem",
    id: item.id,
    patch: {
      notes: "Original user notes",
      projectId: f.store.projects()[0].id,
    },
  });
  f.store.db.exec(
    "DROP TABLE plan_wrapups; DROP TABLE plan_drafts; DROP TABLE plan_undo; DROP TABLE chat_rounds; ALTER TABLE plan_items DROP COLUMN tickets; ALTER TABLE plan_items DROP COLUMN links; ALTER TABLE plan_items DROP COLUMN hiddenLinks; ALTER TABLE plan_items DROP COLUMN categoryOverrides; ALTER TABLE plan_entries DROP COLUMN name; ALTER TABLE plan_entries DROP COLUMN note; PRAGMA user_version=10;",
  );
  f.reopen();
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 11);
  assert.equal(f.plans.items()[0].notes, "Original user notes");
  assert.equal(f.plans.items()[0].tickets[0].key, "DECK-42");
  assert.equal(f.plans.entries()[0].name, "Deck");
  assert.equal(f.plans.entries()[0].note, "Original card annotation");
  assert.equal(f.store.chats()[0].name, "Keep chat");
  assert.equal(f.store.projects()[0].name, "Legacy custom grouping");
  f.reopen();
  assert.equal(
    readdirSync(f.dir).filter((name) => name.includes(".bak-")).length,
    1,
  );
});
test("Markdown cards and fenced YAML stay explicit and reject malformed or ambiguous input", () => {
  assert.equal(
    parseDailyPlan(
      "---\ndate: 2026-10-12\n---\n## Other\n- Ask a colleague\n  Keep this annotation",
    ).items[0].note,
    "Keep this annotation",
  );
  assert.equal(parseDailyPlan("```yaml\n" + card + "```").items.length, 1);
  for (const text of [
    "# 2026-10-12\n## Other\n- A\n## Other\n- B",
    "# 2026-10-12\n## Other\nText without a task",
    "# 2026-02-31\n## Coding\n- A",
  ])
    assert.throws(() => parseDailyPlan(text));
});
