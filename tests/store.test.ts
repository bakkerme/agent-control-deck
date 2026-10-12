import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
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
test("new conversation in an archived chat's project stays separate; resuming and restoring preserve the old record", t => {
  const f = fixture(t);
  f.store.ingest(f.source.id, event("first", "UserPromptSubmit", { prompt: "Original task" }));
  const original = f.store.chats()[0];
  f.store.command({ type: "updateChat", id: original.id, patch: { archived: true, name: "My original task", notes: "Keep this", jiraKey: "APP-42" } });
  f.reopen();
  f.store.ingest(f.source.id, event("new", "UserPromptSubmit", { session_id: "session-2", prompt: "New task" }));
  const next = f.store.chats().find(c => c.externalId === "session-2")!;
  assert.notEqual(next.id, original.id);
  assert.equal(next.projectId, original.projectId);
  assert.equal(next.archived, false);
  f.store.ingest(f.source.id, event("resume", "UserPromptSubmit", { prompt: "Resume original task" }));
  assert.equal(f.store.chat(original.id).archived, true);
  assert.equal(f.store.chat(original.id).state, "running");
  f.store.command({ type: "updateChat", id: original.id, patch: { archived: false } });
  const restored = f.reopen().chat(original.id);
  assert.equal(restored.archived, false);
  assert.equal(restored.name, "My original task");
  assert.equal(restored.notes, "Keep this");
  assert.equal(restored.jiraKey, "APP-42");
  assert.equal(restored.projectId, original.projectId);
  assert.equal(f.store.activity(original.id).length, 2);
  assert.equal(f.store.activity(next.id).length, 1);
  assert.equal(f.store.chats().length, 2);
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
test("repository names are editable while explicit project choices and new defaults persist", t => {
  const f = fixture(t);
  f.store.ingest(f.source.id, event("first", "UserPromptSubmit"));
  const chat = f.store.chats()[0];
  const repo = f.store.projects()[0];
  assert.equal(repo.kind, "repo");
  assert.equal(chat.repoProjectId, repo.id);
  f.store.command({ type: "renameProject", id: repo.id, name: "Changed" });
  const custom = f.store.createProject("Release work");
  assert.throws(() => f.store.command({ type: "addWorkspace", sourceId: f.source.id, projectId: custom, path: "/work/api" }), /cannot be changed/);
  assert.throws(() => f.store.command({ type: "removeWorkspace", id: f.store.workspaces()[0].id }), /permanent/);
  f.store.command({ type: "updateChat", id: chat.id, patch: { projectId: custom, notes: "Keep grouping" } });
  f.store.ingest(f.source.id, event("new", "UserPromptSubmit", { session_id: "new-chat", cwd: "/work/api/src" }));
  f.store.ingest(f.source.id, event("resume", "Stop"));
  const saved = f.reopen().chat(chat.id);
  assert.equal(f.store.projects().find(p => p.id === repo.id)!.name, "Changed");
  assert.equal(saved.projectId, custom);
  assert.equal(saved.repoProjectId, repo.id);
  assert.equal(saved.notes, "Keep grouping");
  assert.equal(f.store.chats().find(c => c.externalId === "new-chat")!.projectId, repo.id);
  f.store.command({ type: "updateChat", id: chat.id, patch: { projectId: null } });
  assert.equal(f.store.chat(chat.id).repoProjectId, repo.id);
  assert.throws(() => f.store.command({ type: "updateChat", id: chat.id, patch: { repoProjectId: null } } as never));
  assert.throws(() => f.store.command({ type: "createProject", name: "Invalid", chatId: "missing" }));
  assert.equal(f.store.projects().length, 2);
  f.store.command({ type: "createProject", name: "Launch", chatId: chat.id });
  assert.equal(f.store.projects().find(p => p.id === f.store.chat(chat.id).projectId)!.name, "Launch");
  assert.equal(f.store.chat(chat.id).repoProjectId, repo.id);
});

test("local Git roots share one project across subfolders and providers; nested repos stay separate", t => {
  const f = fixture(t);
  const root = join(f.dir, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "nested", ".git"), "gitdir: /worktree/metadata");
  f.store.ingest(f.source.id, event("root", "UserPromptSubmit", { cwd: join(root, "src") }));
  f.store.command({ type: "createSource", name: "Second provider", provider: "claude", environment: "native" });
  const source = f.store.sources().find(s => s.id !== f.source.id)!;
  f.store.ingest(source.id, event("second", "UserPromptSubmit", { cwd: root }));
  assert.equal(f.store.projects().length, 1);
  assert.equal(f.store.chats()[0].repoProjectId, f.store.chats()[1].repoProjectId);
  f.store.ingest(f.source.id, event("nested", "UserPromptSubmit", { cwd: join(root, "nested"), session_id: "nested" }));
  assert.equal(f.store.projects().length, 2);
  assert.notEqual(f.store.chats()[0].repoProjectId, f.store.chats().find(c => c.externalId === "nested")!.repoProjectId);
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
    assert.equal(store.db.pragma("user_version", { simple: true }), 13);
    assert.deepEqual(tables.map((table) => store.db.prepare(`SELECT * FROM ${table}`).all().map((row) => {
      const original = { ...row as Record<string, unknown> };
      if (table === "projects") { delete original.kind; delete original.priority; delete original.repositoryPath; delete original.mergedInto; }
      if (table === "chats") { delete original.repoProjectId; delete original.subagentBaselineAt; }
      return original;
    })), before);
    assert.equal(store.chat("c").repoProjectId, "p");
    assert.equal(store.projects()[0].kind, "repo");
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

test("v2 settings migration preserves records, backs up once, and isolates demo settings", (t) => {
  const f = fixture(t);
  f.store.command({ type: "createChat", projectId: null, name: "Before migration" });
  const chat = f.store.chats()[0];
  f.store.command({ type: "updateChat", id: chat.id, patch: { notes: "## Keep Markdown", jiraKey: "DECK-42", archived: true } });
  const before = f.store.chat(chat.id);
  f.store.db.exec("DROP TABLE matching_measurements; DROP TABLE matching_feedback; DROP TABLE ai_link_dismissals; DROP TABLE ai_match_attempts; DROP TABLE plan_wrapups; DROP TABLE plan_drafts; DROP TABLE plan_undo; DROP TABLE chat_rounds; DROP TABLE plan_chats; DROP TABLE plan_entries; DROP TABLE plan_imports; DROP TABLE plan_items; DROP TABLE background_snapshots; DROP TABLE chat_links; DROP TABLE settings; DROP TABLE subagents; ALTER TABLE chats DROP COLUMN subagentBaselineAt; ALTER TABLE chats DROP COLUMN repoProjectId; ALTER TABLE projects DROP COLUMN priority; ALTER TABLE projects DROP COLUMN kind; ALTER TABLE projects DROP COLUMN mergedInto; ALTER TABLE projects DROP COLUMN repositoryPath; PRAGMA user_version=2;");
  const migrated = f.reopen();
  assert.deepEqual(migrated.chat(chat.id), before);
  assert.deepEqual(migrated.settings(), { jiraBaseUrl: "", linkRules: [] });
  assert.equal(migrated.db.pragma("user_version", { simple: true }), 13);
  migrated.command({ type: "updateSettings", jiraBaseUrl: "https://company.example/jira/" });
  assert.deepEqual(f.reopen().settings(), { jiraBaseUrl: "https://company.example/jira", linkRules: [] });
  assert.equal(readdirSync(f.dir).filter(n => /^workspace\.sqlite\.bak-\d+$/.test(n)).length, 1);
  assert.throws(() => f.store.command({ type: "updateSettings", jiraBaseUrl: "javascript:alert(1)" }));
  assert.equal(f.store.settings().jiraBaseUrl, "https://company.example/jira");
  const demo = new Store(join(f.dir, "demo", "workspace.sqlite"));
  try {
    assert.equal(demo.settings().jiraBaseUrl, "");
    demo.command({ type: "updateSettings", jiraBaseUrl: "https://demo.example" });
    assert.equal(f.store.settings().jiraBaseUrl, "https://company.example/jira");
  } finally { demo.close(); }
});

test("v3 repository migration joins proven local roots and preserves custom assignments", t => {
  const f = fixture(t);
  const root = join(f.dir, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  const original = f.store.createProject("Original repo name");
  const duplicate = f.store.createProject("Second provider group");
  const custom = f.store.createProject("My release");
  f.store.db.prepare("INSERT INTO workspaces VALUES (?,?,?,?)").run("root", f.source.id, original, root);
  f.store.db.prepare("INSERT INTO workspaces VALUES (?,?,?,?)").run("subdir", f.source.id, duplicate, join(root, "src"));
  f.store.db.prepare("INSERT INTO chats (id,projectId,provider,sourceId,externalId,name,notes,jiraKey,archived,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("legacy", duplicate, "claude", f.source.id, "legacy", "My task", "Keep notes", "APP-42", 1, "2026-01-01", "2026-01-01");
  f.store.db.prepare("INSERT INTO chats (id,projectId,provider,sourceId,externalId,name,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)")
    .run("moved", custom, "claude", f.source.id, "moved", "Moved task", "2026-01-01", "2026-01-01");
  f.store.db.exec("DROP TABLE matching_measurements; DROP TABLE matching_feedback; DROP TABLE ai_link_dismissals; DROP TABLE ai_match_attempts; DROP TABLE plan_wrapups; DROP TABLE plan_drafts; DROP TABLE plan_undo; DROP TABLE chat_rounds; DROP TABLE plan_chats; DROP TABLE plan_entries; DROP TABLE plan_imports; DROP TABLE plan_items; DROP TABLE background_snapshots; DROP TABLE chat_links; DROP TABLE subagents; ALTER TABLE chats DROP COLUMN subagentBaselineAt; ALTER TABLE chats DROP COLUMN repoProjectId; ALTER TABLE projects DROP COLUMN priority; ALTER TABLE projects DROP COLUMN kind; ALTER TABLE projects DROP COLUMN mergedInto; ALTER TABLE projects DROP COLUMN repositoryPath; PRAGMA user_version=3;");
  const migrated = f.reopen();
  const chat = migrated.chat("legacy");
  assert.equal(chat.repoProjectId, original);
  assert.equal(chat.projectId, duplicate);
  assert.equal(chat.name, "My task");
  assert.equal(chat.notes, "Keep notes");
  assert.equal(chat.jiraKey, "APP-42");
  assert.equal(chat.archived, true);
  assert.equal(migrated.projects().filter(p => p.kind === "repo").length, 1);
  assert.equal(migrated.projects().find(p => p.id === duplicate)!.kind, "custom");
  assert.equal(migrated.workspaces().every(w => w.projectId === original), true);
  migrated.ingest(f.source.id, event("backfill", "Stop", { session_id: "moved", cwd: root }));
  assert.equal(migrated.chat("moved").repoProjectId, original);
  assert.equal(migrated.chat("moved").projectId, custom);
  assert.deepEqual(migrated.db.pragma("foreign_key_check"), []);
  assert.equal(readdirSync(f.dir).filter(n => /^workspace\.sqlite\.bak-\d+$/.test(n)).length, 1);
  assert.equal(f.reopen().chat("legacy").repoProjectId, original);
});

test("project priority survives provider updates, rename, restart, and stays isolated from demo", t => {
  const f = fixture(t);
  f.store.ingest(f.source.id, event("start", "UserPromptSubmit", { prompt: "Priority work" }));
  const repo = f.store.projects()[0];
  const customId = f.store.createProject("Release");
  assert.equal(repo.priority, false);
  assert.equal(f.store.projects().find(p => p.id === customId)!.priority, false);
  for (const id of [repo.id, customId]) f.store.command({ type: "setProjectPriority", id, priority: true });
  f.store.command({ type: "renameProject", id: customId, name: "Release review" });
  f.store.ingest(f.source.id, event("stop", "Stop", {}, "2026-01-01T00:01:00Z"));
  assert.equal(f.reopen().projects().filter(p => p.priority).length, 2);
  assert.throws(() => f.store.command({ type: "setProjectPriority", id: "missing", priority: true }), /existing project/);
  assert.throws(() => f.store.command({ type: "setProjectPriority", id: repo.id, priority: "true" as unknown as boolean }));
  assert.equal(f.store.projects().find(p => p.id === repo.id)!.priority, true);
  f.store.command({ type: "setProjectPriority", id: repo.id, priority: false });
  assert.equal(f.reopen().projects().find(p => p.id === repo.id)!.priority, false);
  assert.equal(f.store.projects().find(p => p.id === customId)!.priority, true);
  const demo = new Store(join(f.dir, "demo", "workspace.sqlite"));
  try {
    seedDemo(demo);
    assert.ok(demo.projects().every(p => !p.priority));
  } finally { demo.close(); }
});

test("v5 priority migration defaults flags off, preserves records, and backs up once", t => {
  const f = fixture(t);
  f.store.ingest(f.source.id, event("start", "UserPromptSubmit", { prompt: "Keep task" }));
  const chat = f.store.chats()[0];
  f.store.command({ type: "updateChat", id: chat.id, patch: { notes: "Keep notes", jiraKey: "APP-7", archived: true } });
  const before = f.store.chat(chat.id);
  const activities = f.store.activity(chat.id);
  const projects = f.store.projects();
  f.store.db.exec("DROP TABLE matching_measurements; DROP TABLE matching_feedback; DROP TABLE ai_link_dismissals; DROP TABLE ai_match_attempts; DROP TABLE plan_wrapups; DROP TABLE plan_drafts; DROP TABLE plan_undo; DROP TABLE chat_rounds; DROP TABLE plan_chats; DROP TABLE plan_entries; DROP TABLE plan_imports; DROP TABLE plan_items; DROP TABLE background_snapshots; DROP TABLE chat_links; ALTER TABLE projects DROP COLUMN priority; ALTER TABLE projects DROP COLUMN mergedInto; ALTER TABLE projects DROP COLUMN repositoryPath; PRAGMA user_version=5;");
  f.reopen();
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 13);
  assert.deepEqual(f.store.chat(chat.id), {...before, latestRound: null});
  assert.deepEqual(f.store.activity(chat.id), activities);
  assert.deepEqual(f.store.projects(), projects);
  assert.deepEqual(f.store.db.pragma("foreign_key_check"), []);
  const backups = readdirSync(f.dir).filter(n => /^workspace\.sqlite\.bak-\d+$/.test(n));
  assert.equal(backups.length, 1);
  const backup = new Database(join(f.dir, backups[0]), { readonly: true });
  try { assert.equal(backup.pragma("user_version", { simple: true }), 5); } finally { backup.close(); }
  f.store.command({ type: "setProjectPriority", id: projects[0].id, priority: true });
  f.reopen();
  assert.equal(f.store.projects()[0].priority, true);
  assert.equal(readdirSync(f.dir).filter(n => /^workspace\.sqlite\.bak-\d+$/.test(n)).length, 1);
});

test("a newer database is rejected without resetting it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-newer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, "workspace.sqlite");
  const db = new Database(filename);
  db.exec("CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version=14;");
  db.close();
  assert.throws(() => new Store(filename), /newer version/);
  const preserved = new Database(filename, { readonly: true });
  try { assert.deepEqual(preserved.prepare("SELECT * FROM future_data").all(), [{ value: "keep" }]); } finally { preserved.close(); }
});
