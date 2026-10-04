import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../src/main/store";
import { seedDemo } from "../src/main/demo";
import { normalize } from "../src/main/providers";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "acd-store-"));
  let store = new Store(join(dir, "workspace.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.command({
    type: "createSource",
    name: "Claude",
    provider: "claude",
    environment: "native",
  });
  const source = store.sources()[0];
  return {
    dir,
    get store() {
      return store;
    },
    source,
    reopen() {
      store.close();
      store = new Store(join(dir, "workspace.sqlite"));
      return store;
    },
  };
}
const event = (
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
  observedAt = "2026-01-01T00:00:00.000Z",
) => ({
  version: 1,
  eventId: id,
  observedAt,
  payload: {
    hook_event_name: type,
    session_id: "session-1",
    cwd: "/work/api",
    ...extra,
  },
});

test("user records, archive, and references survive live events, restart, and session end", (t) => {
  const f = fixture(t);
  f.store.ingest(
    f.source.id,
    event("1", "UserPromptSubmit", { prompt: "Build the API" }),
  );
  const id = f.store.chats()[0].id;
  f.store.command({
    type: "updateChat",
    id,
    patch: {
      name: "My task",
      notes: "Keep my decisions",
      jiraKey: "APP-42",
      jiraUrl: "https://jira.example/browse/APP-42",
      archived: true,
    },
  });
  f.store.ingest(
    f.source.id,
    event(
      "2",
      "Stop",
      { last_assistant_message: "Ready for review" },
      "2026-01-01T00:01:00Z",
    ),
  );
  f.store.ingest(
    f.source.id,
    event("3", "SessionEnd", {}, "2026-01-01T00:02:00Z"),
  );
  const chat = f.reopen().chat(id);
  assert.equal(chat.name, "My task");
  assert.equal(chat.notes, "Keep my decisions");
  assert.equal(chat.jiraKey, "APP-42");
  assert.equal(chat.archived, true);
  assert.equal(chat.lifecycle, "ended");
  assert.equal(chat.state, "idle");
  assert.equal(chat.preview, "Ready for review");
  assert.equal(f.store.activity(id).length, 3);
});
test("events deduplicate across restart and delayed observations cannot regress status", (t) => {
  const f = fixture(t);
  f.store.ingest(f.source.id, event("first", "UserPromptSubmit"));
  const recent = event("new", "Stop", {}, "2026-01-01T01:00:00Z");
  assert.equal(f.store.ingest(f.source.id, recent), true);
  assert.equal(f.reopen().ingest(f.source.id, recent), false);
  f.store.ingest(
    f.source.id,
    event("old", "UserPromptSubmit", { prompt: "Earlier prompt" }),
  );
  assert.equal(f.store.chats()[0].state, "idle");
  assert.equal(f.store.activity(f.store.chats()[0].id).length, 3);
  assert.equal(f.store.sources()[0].accepted, 3);
});
test("projects match source-scoped workspace aliases and longest path boundaries", (t) => {
  const f = fixture(t);
  f.store.command({ type: "createProject", name: "Shared work" });
  const project = f.store.projects()[0];
  f.store.command({
    type: "addWorkspace",
    sourceId: f.source.id,
    projectId: project.id,
    path: "/work/api",
  });
  f.store.command({
    type: "addWorkspace",
    sourceId: f.source.id,
    projectId: project.id,
    path: "C:\\Work\\Api",
  });
  f.store.ingest(
    f.source.id,
    event("a", "UserPromptSubmit", { session_id: "linux", cwd: "/work/api/src" }),
  );
  f.store.ingest(
    f.source.id,
    event("b", "UserPromptSubmit", { session_id: "windows", cwd: "c:\\work\\API" }),
  );
  f.store.ingest(
    f.source.id,
    event("c", "UserPromptSubmit", { session_id: "other", cwd: "/work/api-extra" }),
  );
  assert.equal(
    f.store.chats().filter((c) => c.projectId === project.id).length,
    2,
  );
  assert.equal(f.store.projects().length, 2);
  assert.equal(f.store.chats().length, 3);
});
test("same external ID in different providers/environments creates distinct chats", (t) => {
  const f = fixture(t);
  f.store.command({
    type: "createSource",
    name: "Cursor",
    provider: "cursor",
    environment: "native",
  });
  const cursor = f.store.sources().find((s) => s.provider === "cursor")!;
  f.store.ingest(f.source.id, event("claude", "UserPromptSubmit"));
  f.store.ingest(cursor.id, {
    version: 1,
    eventId: "cursor",
    payload: {
      conversation_id: "session-1",
      hook_event_name: "beforeSubmitPrompt",
      workspace_roots: ["/work/api"],
    },
  });
  assert.equal(f.store.chats().length, 2);
});
test("bounds history and previews while rejecting invalid writes without partial mutations", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 110; i++)
    f.store.ingest(
      f.source.id,
      event(String(i), "UserPromptSubmit", { prompt: "x".repeat(1000) }),
    );
  const chat = f.store.chats()[0];
  assert.equal(f.store.activity(chat.id).length, 100);
  assert.equal(chat.preview.length, 500);
  assert.throws(() =>
    f.store.command({
      type: "updateChat",
      id: chat.id,
      patch: { state: "running", notes: "Not allowed" },
    }),
  );
  assert.throws(() =>
    f.store.command({
      type: "updateChat",
      id: chat.id,
      patch: { jiraUrl: "javascript:alert(1)" },
    }),
  );
  assert.equal(f.store.chat(chat.id).notes, "");
  assert.throws(() =>
    f.store.ingest(f.source.id, event("missing", "Stop", { session_id: "" })),
  );
  assert.equal(f.store.sources()[0].accepted, 110);
});
test("provider-specific lifecycle semantics do not mistake a turn or response for task completion", (t) => {
  const f = fixture(t);
  assert.equal(
    normalize(f.source, {
      session_id: "x",
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
    })?.state,
    "idle",
  );
  assert.equal(
    normalize(f.source, {
      session_id: "x",
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    })?.state,
    "waiting",
  );
  const cursor = { ...f.source, provider: "cursor" as const };
  assert.equal(
    normalize(cursor, {
      conversation_id: "x",
      hook_event_name: "stop",
      status: "error",
    })?.state,
    "error",
  );
  assert.equal(
    normalize(cursor, {
      conversation_id: "x",
      hook_event_name: "afterAgentResponse",
      text: "<script>hello</script>",
    })?.state,
    undefined,
  );
  assert.equal(
    normalize(cursor, {
      conversation_id: "x",
      hook_event_name: "preToolUse",
      tool_input: "ignored",
    }),
    null,
  );
});
test("demo and real stores are isolated and startup migrations preserve an existing file", (t) => {
  const f = fixture(t);
  const demo = new Store(join(f.dir, "demo", "workspace.sqlite"));
  try {
    seedDemo(demo);
    assert.equal(demo.chats().length, 4);
    assert.equal(f.store.chats().length, 0);
  } finally {
    demo.close();
  }
  const empty = join(f.dir, "old.sqlite");
  writeFileSync(empty, "");
  const migrated = new Store(empty);
  migrated.close();
  assert.ok(
    readdirSync(f.dir).some((name) => name.startsWith("old.sqlite.bak-")),
  );
});


test("manual chats can be created without projects, assigned, detached, and persisted", (t) => {
  const f = fixture(t);
  f.store.command({ type: "createChat", projectId: null, name: "Standalone" });
  const chat = f.store.chats()[0];
  assert.equal(chat.projectId, null);
  assert.equal(f.store.projects().length, 0);
  const projectId = f.store.createProject("Work");
  f.store.command({ type: "updateChat", id: chat.id, patch: { projectId, notes: "Keep this" } });
  assert.equal(f.store.chat(chat.id).projectId, projectId);
  assert.throws(() => f.store.command({ type: "updateChat", id: chat.id, patch: { projectId: "missing" } }));
  assert.equal(f.store.chat(chat.id).projectId, projectId);
  f.store.command({ type: "updateChat", id: chat.id, patch: { projectId: null, archived: true } });
  const saved = f.reopen().chat(chat.id);
  assert.equal(saved.projectId, null);
  assert.equal(saved.notes, "Keep this");
  assert.equal(saved.archived, true);
});

test("missing workspaces create unassigned chats and hooks preserve manual removal", (t) => {
  const f = fixture(t);
  f.store.ingest(f.source.id, event("no-workspace", "UserPromptSubmit", { cwd: undefined }));
  assert.equal(f.store.chats()[0].projectId, null);
  assert.equal(f.store.projects().length, 0);
  f.store.ingest(f.source.id, event("with-workspace", "UserPromptSubmit", { session_id: "workspace-chat" }));
  const chat = f.store.chats().find((c) => c.externalId === "workspace-chat")!;
  assert.ok(chat.projectId);
  f.store.command({ type: "updateChat", id: chat.id, patch: { projectId: null } });
  f.store.ingest(f.source.id, event("later", "Stop", { session_id: "workspace-chat" }));
  assert.equal(f.reopen().chat(chat.id).projectId, null);
  assert.equal(f.store.activity(chat.id).length, 2);
  assert.equal(f.store.workspaces().length, 1);
});

test("demo backfills its standalone sample once and preserves later assignment and edits", (t) => {
  const f = fixture(t);
  seedDemo(f.store);
  const sample = f.store.chats().find((c) => c.projectId === null)!;
  assert.equal(sample.name, "Explore a standalone idea");
  // Reproduce a previously seeded demo that lacks the new sample.
  f.store.db.prepare("DELETE FROM chats WHERE id=?").run(sample.id);
  seedDemo(f.store);
  assert.equal(f.store.chats().length, 4);
  f.store.command({ type: "updateChat", id: sample.id, patch: {
    projectId: f.store.projects()[0].id, notes: "My demo edit", archived: true,
  } });
  const edited = f.store.chat(sample.id);
  seedDemo(f.reopen());
  assert.equal(f.store.chats().length, 4);
  assert.deepEqual(f.store.chat(sample.id), edited);
});

test("v1 migration backs up and preserves chats, relationships, history, and deduplication", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-v1-"));
  const filename = join(dir, "workspace.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new Database(filename);
  legacy.exec(readFileSync("tests/fixtures/store-v1.sql", "utf8"));
  legacy.exec(`
    INSERT INTO projects VALUES ('p', 'Unassigned', '2026-01-01');
    INSERT INTO sources (id,name,provider,environment) VALUES ('s','Claude','claude','native');
    INSERT INTO workspaces VALUES ('w','s','p','/work/api');
    INSERT INTO chats (id,projectId,provider,sourceId,externalId,name,notes,jiraKey,jiraUrl,archived,state,lifecycle,preview,lastEventAt,createdAt,updatedAt)
      VALUES ('c','p','claude','s','session-1','My title','Keep notes','API-1','https://jira.example/browse/API-1',1,'idle','ended','Result','2026-01-01','2026-01-01','2026-01-01');
    INSERT INTO activities VALUES ('a','c','2026-01-01','Stop','Result');
    INSERT INTO processed_events VALUES ('s','seen');
  `);
  const tables = ["projects", "sources", "workspaces", "chats", "activities", "processed_events"];
  const before = tables.map((table) => legacy.prepare(`SELECT * FROM ${table}`).all());
  legacy.close();
  const store = new Store(filename);
  try {
    assert.equal(store.db.pragma("user_version", { simple: true }), 2);
    assert.deepEqual(tables.map((table) => store.db.prepare(`SELECT * FROM ${table}`).all()), before);
    assert.deepEqual(store.db.pragma("foreign_key_check"), []);
    assert.equal(store.db.pragma("foreign_keys", { simple: true }), 1);
    assert.throws(() => store.db.prepare("DELETE FROM chats WHERE id='c'").run(), /FOREIGN KEY/);
    assert.equal(store.ingest("s", event("seen", "SessionStart")), false);
    store.command({ type: "updateChat", id: "c", patch: { projectId: null } });
    assert.equal(store.chat("c").projectId, null);
    assert.equal(store.activity("c").length, 1);
    const backupName = readdirSync(dir).find((name) => name.startsWith("workspace.sqlite.bak-"))!;
    assert.ok(backupName);
    const backup = new Database(join(dir, backupName), { readonly: true });
    try {
      assert.equal(backup.pragma("user_version", { simple: true }), 1);
      assert.deepEqual(backup.prepare("SELECT * FROM chats").all(), before[3]);
    } finally { backup.close(); }
  } finally { store.close(); }
  const reopened = new Store(filename);
  try {
    assert.equal(reopened.chat("c").projectId, null);
    assert.equal(reopened.projects()[0].name, "Unassigned");
    assert.equal(readdirSync(dir).filter((name) => /\.bak-\d+$/.test(name)).length, 1);
  } finally { reopened.close(); }
});
