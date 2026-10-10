import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { normalize } from "../src/main/providers";
import { Inbox } from "../src/main/inbox";
import { effectiveState, finishedTurn, statusLabel, priorityAttention, SUBAGENT_OBSERVATION_AGE } from "../src/shared/status";

function fixture(t: { after: (fn: () => void) => void }, provider: "codex" | "claude" | "cursor" = "codex") {
  const dir = mkdtempSync(join(tmpdir(), "acd-subagents-"));
  let store = new Store(join(dir, "workspace.sqlite"));
  store.command({ type: "createSource", name: provider, provider, environment: "native" });
  const source = store.sources()[0];
  let sequence = 0;
  const base = Date.now() - 10000;
  const emit = (event: string, payload: Record<string, unknown> = {}, offset = ++sequence, eventId = `event-${sequence}`) => store.ingest(source.id, {
    version: 1, eventId, observedAt: new Date(base + offset).toISOString(),
    payload: { hook_event_name: event, session_id: "parent", conversation_id: "parent", ...payload },
  });
  const prompt = provider === "cursor" ? "beforeSubmitPrompt" : "UserPromptSubmit";
  emit(prompt, { prompt: "Parent task" });
  const id = store.chats()[0].id;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    dir, source, emit, id, base, get store() { return store; }, get chat() { return store.chat(id); },
    reopen() { store.close(); store = new Store(join(dir, "workspace.sqlite")); },
  };
}

test("parent stop retains parallel work, deduplication and user data across restart", t => {
  const f = fixture(t);
  f.store.command({ type: "updateChat", id: f.id, patch: { name: "My task", notes: "Keep notes", archived: true, projectId: null, jiraKey: "APP-1" } });
  f.emit("SubagentStart", { agent_id: "one", agent_type: "Explore" }, 2, "start-one");
  assert.equal(f.emit("SubagentStart", { agent_id: "one" }, 2, "start-one"), false);
  f.emit("SubagentStart", { agent_id: "two", agent_type: "Reviewer" }, 3, "start-two");
  assert.equal(statusLabel(f.chat), "Running · 2 subagents working");
  f.emit("Stop", { last_assistant_message: "Parent response" }, 4, "parent-stop");
  assert.equal(f.chat.state, "idle");
  assert.equal(effectiveState(f.chat), "running");
  assert.equal(finishedTurn(f.chat), false);
  assert.equal(statusLabel(f.chat), "Main turn finished · 2 subagents working");
  f.reopen();
  assert.equal(f.chat.subagents.length, 2);
  f.emit("SubagentStop", { agent_id: "one", agent_type: "Explore", last_assistant_message: "Child response" }, 5, "stop-one");
  assert.equal(f.chat.preview, "Parent response");
  assert.equal(statusLabel(f.chat), "Main turn finished · 1 subagent working");
  f.emit("SubagentStop", { agent_id: "two" }, 6, "stop-two");
  assert.equal(statusLabel(f.chat), "Turn finished");
  assert.equal(finishedTurn(f.chat), true);
  assert.equal(f.chat.name, "My task");
  assert.equal(f.chat.notes, "Keep notes");
  assert.equal(f.chat.jiraKey, "APP-1");
  assert.equal(f.chat.archived, true);
  assert.equal(f.chat.projectId, null);
});

test("agent timestamps are independent of parent activity, ordered per ID and isolated per source", t => {
  const f = fixture(t);
  f.emit("Stop", {}, 50, "parent-stop");
  // These arrived after the parent stop but were observed before it.
  f.emit("SubagentStart", { agent_id: "worker" }, 10, "start");
  assert.equal(f.chat.subagents.length, 1);
  assert.equal(f.chat.state, "idle");
  f.emit("SubagentStop", { agent_id: "worker" }, 20, "stop");
  f.emit("SubagentStart", { agent_id: "worker" }, 15, "late-start");
  assert.equal(f.chat.subagents.length, 0);
  // A stop-before-start delivery retains a tombstone, even for unknown workers.
  f.emit("SubagentStop", { agent_id: "other" }, 30, "early-stop");
  f.emit("SubagentStart", { agent_id: "other" }, 25, "late-other-start");
  assert.equal(f.chat.subagents.length, 0);
  f.emit("SubagentStart", { agent_id: "worker" }, 60, "resumed");
  f.store.command({ type: "createSource", name: "Other Codex", provider: "codex", environment: "native" });
  const other = f.store.sources().find(s => s.id !== f.source.id)!;
  f.store.ingest(other.id, { version: 1, eventId: "prompt", payload: { hook_event_name: "UserPromptSubmit", session_id: "parent" } });
  f.store.ingest(other.id, { version: 1, eventId: "stop", payload: { hook_event_name: "SubagentStop", session_id: "parent", agent_id: "worker" } });
  assert.equal(f.chat.subagents.length, 1);
  assert.deepEqual(f.store.chats().find(c => c.sourceId === other.id)!.subagents, []);
});

test("Claude background registry snapshots replace lifecycle IDs and resolve missing starts", t => {
  const f = fixture(t, "claude");
  f.emit("SubagentStart", { agent_id: "agent-one" }, 2, "start");
  f.emit("Stop", { background_tasks: [
    { id: "task-one", type: "subagent", agent_type: "Explore", status: "running" },
    { id: "task-two", type: "subagent", agent_type: "Reviewer", status: "running" },
    { id: "shell", type: "shell", status: "running" },
  ] }, 3, "snapshot");
  assert.equal(f.chat.subagents.length, 2);
  assert.equal(statusLabel(f.chat), "Main turn finished · 2 subagents working · 1 background task working");
  f.emit("SubagentStop", { agent_id: "agent-one", background_tasks: [
    { id: "task-two", type: "subagent", agent_type: "Reviewer", status: "running" },
  ] }, 4, "one-stopped");
  assert.equal(f.chat.subagents.length, 1);
  f.emit("SubagentStop", { agent_id: "agent-two", background_tasks: [] }, 5, "all-stopped");
  f.emit("SubagentStart", { agent_id: "late-start" }, 2, "stale-start");
  f.emit("Stop", { background_tasks: [{ id: "stale-task", type: "subagent" }] }, 3, "stale-snapshot");
  assert.equal(f.chat.subagents.length, 0);
  assert.equal(finishedTurn(f.chat), true);
  assert.throws(() => f.emit("Stop", { background_tasks: {} }, 6, "bad-snapshot"));
  assert.throws(() => f.emit("Stop", { background_tasks: [{ type: "subagent" }] }, 6, "bad-task"));
});

test("Cursor links to the parent, and unidentified stops expose uncertainty", t => {
  const f = fixture(t, "cursor");
  f.emit("subagentStart", { parent_conversation_id: "parent", conversation_id: "child", subagent_id: "one", subagent_type: "explore" });
  f.emit("subagentStart", { parent_conversation_id: "parent", subagent_id: "two", subagent_type: "shell" });
  f.emit("stop");
  assert.equal(statusLabel(f.chat), "Main turn finished · 2 subagents working");
  f.emit("subagentStop", { parent_conversation_id: "parent", subagent_type: "explore", status: "completed" });
  assert.equal(statusLabel(f.chat), "Main turn finished · 2 subagents status uncertain");
  assert.equal(effectiveState(f.chat), "unknown");
  assert.equal(finishedTurn(f.chat), false);
  assert.equal(f.store.chats().length, 1);
  f.emit("subagentStop", { subagent_id: "one", status: "completed" });
  f.emit("subagentStop", { subagent_id: "two", status: "aborted" });
  assert.equal(finishedTurn(f.chat), true);
});

test("old observations and session endings retain uncertainty; parent interruption does not end workers", t => {
  const f = fixture(t);
  f.emit("SubagentStart", { agent_id: "worker" }, 2, "start");
  f.emit("Interrupt", {}, 3, "interrupt");
  assert.equal(effectiveState(f.chat), "running");
  const staleTime = f.base + 2 + SUBAGENT_OBSERVATION_AGE;
  assert.equal(effectiveState(f.chat, staleTime), "unknown");
  assert.equal(statusLabel(f.chat, staleTime), "Main turn finished · 1 subagent status uncertain");
  assert.equal(finishedTurn(f.chat), false);
  f.emit("SessionEnd", {}, 4, "end");
  assert.equal(statusLabel(f.chat), "Ended · 1 subagent status uncertain");
  f.emit("SubagentStart", { agent_id: "missed-old-worker" }, 3, "old-start");
  assert.equal(f.chat.subagents.length, 1);
  f.emit("SubagentStop", { agent_id: "worker" }, 5, "stop");
  assert.deepEqual(f.chat.subagents, []);
});

test("events sharing a timestamp can stop and resume an observed worker", t => {
  const f = fixture(t);
  f.emit("SubagentStart", { agent_id: "worker" }, 2, "start");
  f.emit("SessionEnd", {}, 3, "end");
  f.emit("SubagentStop", { agent_id: "worker" }, 3, "stop");
  assert.deepEqual(f.chat.subagents, []);
  f.emit("UserPromptSubmit", {}, 4, "prompt");
  f.emit("SubagentStart", { agent_id: "worker" }, 4, "resume");
  assert.equal(f.chat.subagents.length, 1);
});

test("subagent payload validation and transactional capacity preserve queued work", t => {
  const f = fixture(t);
  assert.throws(() => normalize(f.source, { session_id: "parent", hook_event_name: "SubagentStart" }), /valid ID/);
  assert.throws(() => normalize(f.source, { session_id: "parent", hook_event_name: "SubagentStart", agent_id: "x".repeat(2001) }), /valid ID/);
  f.store.db.transaction(() => {
    for (let i = 0; i < 1000; i++) f.store.db.prepare("INSERT INTO subagents VALUES (?,?,?,?,?)")
      .run(f.id, `agent:${i}`, "Explore", "running", new Date(f.base).toISOString());
  })();
  assert.throws(() => f.emit("SubagentStart", { agent_id: "overflow" }, 2, "overflow"), /capacity/);
  assert.equal(f.store.db.prepare("SELECT 1 FROM processed_events WHERE eventId='overflow'").get(), undefined);
  const inbox = new Inbox(f.store, f.dir, () => {});
  inbox.enqueue(f.source.id, {
    version: 1, eventId: "queued-overflow", observedAt: new Date(f.base + 4).toISOString(),
    payload: { hook_event_name: "SubagentStart", session_id: "parent", agent_id: "overflow" },
  });
  inbox.poll();
  const queue = join(f.dir, "inbox", f.source.id);
  assert.equal(readdirSync(queue).length, 1);
  f.emit("SubagentStop", { agent_id: "0" }, 3, "free-space");
  inbox.poll();
  assert.equal(readdirSync(queue).length, 0);
  assert.equal(f.chat.subagents.length, 1000);
});

test("v4 migration preserves user data and backs up once without fabricating observations", t => {
  const f = fixture(t);
  f.store.command({ type: "updateChat", id: f.id, patch: { name: "Keep", notes: "Personal", archived: true } });
  const before = f.chat;
  f.store.db.exec("DROP TABLE plan_wrapups; DROP TABLE plan_drafts; DROP TABLE plan_undo; DROP TABLE chat_rounds; DROP TABLE plan_chats; DROP TABLE plan_entries; DROP TABLE plan_imports; DROP TABLE plan_items; DROP TABLE background_snapshots; DROP TABLE chat_links; DROP TABLE subagents; ALTER TABLE chats DROP COLUMN subagentBaselineAt; ALTER TABLE projects DROP COLUMN priority; ALTER TABLE projects DROP COLUMN mergedInto; ALTER TABLE projects DROP COLUMN repositoryPath; PRAGMA user_version=4;");
  f.reopen();
  assert.deepEqual(f.chat, {...before, latestRound: null});
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 11);
  assert.deepEqual(f.store.db.pragma("foreign_key_check"), []);
  f.reopen();
  assert.equal(readdirSync(f.dir).filter(name => name.includes(".bak-")).length, 1);
});

test("Claude monitors and scheduled checks survive turns, restarts and user edits", t => {
  const f = fixture(t, "claude");
  f.store.command({ type: "updateChat", id: f.id, patch: { name: "Watch CI", notes: "Keep", jiraKey: "APP-9", archived: true } });
  f.store.command({ type: "createProject", name: "Release", chatId: f.id });
  const check = { id: "check", schedule: "*/10 * * * *", recurring: true, prompt: "Check CI" };
  f.emit("Stop", { background_tasks: [{ id: "watcher", type: "monitor", status: "running", description: "Watch the build" }], session_crons: [check] }, 2, "watching");
  assert.equal(effectiveState(f.chat), "monitoring");
  assert.equal(statusLabel(f.chat), "Monitoring · 1 monitor observed · 1 scheduled check");
  assert.equal(finishedTurn(f.chat), false);
  f.reopen();
  assert.equal(f.chat.backgroundTasks[0].description, "Watch the build");
  assert.equal(f.chat.scheduledChecks[0].prompt, "Check CI");
  assert.equal(f.chat.name, "Watch CI");
  assert.equal(f.chat.notes, "Keep");
  assert.equal(f.chat.jiraKey, "APP-9");
  assert.equal(f.chat.archived, true);
  f.emit("UserPromptSubmit", {}, 3, "new-turn");
  assert.equal(effectiveState(f.chat), "running");
  f.emit("Stop", { background_tasks: [], session_crons: [check] }, 4, "next-stop");
  assert.equal(statusLabel(f.chat), "Monitoring · waiting for next check");
  const tomorrow = f.base + 24 * 60 * 60 * 1000;
  assert.equal(effectiveState(f.chat, tomorrow), "monitoring");
  assert.equal(f.chat.scheduledChecks[0].lastEventAt, new Date(f.base + 4).toISOString());
  f.store.command({ type: "updateChat", id: f.id, patch: { archived: false } });
  const projects = [{ id: f.chat.projectId!, name: "Priority", kind: "custom" as const, priority: true, createdAt: "" }];
  assert.equal(priorityAttention(f.chat, projects), null);
  f.emit("Notification", { notification_type: "permission_prompt" }, 5, "attention");
  assert.equal(effectiveState(f.chat), "waiting");
  assert.match(statusLabel(f.chat), /^Needs input/);
  assert.equal(priorityAttention(f.chat, projects), "Needs input");
  f.emit("StopFailure", { error: "rate_limit" }, 6, "error");
  assert.equal(effectiveState(f.chat), "error");
  assert.match(statusLabel(f.chat), /^Error/);
});

test("background snapshots clear independently, retain absent fields and reject delayed resurrection", t => {
  const f = fixture(t, "claude");
  const background_tasks = [{ id: "monitor", type: "monitor" }];
  const session_crons = [{ id: "cron", schedule: "0 9 * * *", recurring: false }];
  f.emit("Stop", { background_tasks, session_crons }, 2, "initial");
  f.emit("Stop", {}, 10, "absent");
  assert.equal(f.chat.backgroundTasks.length, 1);
  assert.equal(f.chat.scheduledChecks.length, 1);
  f.emit("SubagentStop", { agent_id: "worker", background_tasks: [] }, 4, "tasks-clear");
  assert.deepEqual(f.chat.backgroundTasks, []);
  assert.equal(f.chat.scheduledChecks.length, 1);
  f.emit("Stop", { background_tasks }, 3, "old-tasks");
  assert.deepEqual(f.chat.backgroundTasks, []);
  f.emit("Stop", { session_crons: [] }, 5, "checks-clear");
  f.emit("Stop", { session_crons }, 3, "old-checks");
  assert.deepEqual(f.chat.scheduledChecks, []);
  assert.equal(finishedTurn(f.chat), true);
  f.reopen();
  f.emit("Stop", { background_tasks, session_crons }, 2, "old-after-restart");
  assert.equal(finishedTurn(f.chat), true);
});

test("background task age and session endings expose uncertainty without declaring completion", t => {
  const f = fixture(t, "claude");
  f.emit("Stop", { background_tasks: [{ id: "shell", type: "shell" }, { id: "monitor", type: "monitor" }] }, 2, "tasks");
  assert.equal(effectiveState(f.chat), "running");
  assert.equal(statusLabel(f.chat), "Main turn finished · 1 background task working · 1 monitor observed");
  const stale = f.base + 2 + SUBAGENT_OBSERVATION_AGE;
  assert.equal(effectiveState(f.chat, stale), "unknown");
  assert.equal(statusLabel(f.chat, stale), "Main turn finished · 2 background observations uncertain");
  assert.equal(finishedTurn(f.chat), false);
  f.emit("Stop", { session_crons: [{ id: "cron", schedule: "0 9 * * *", recurring: true }] }, 3, "schedule");
  f.emit("SessionEnd", {}, 4, "end");
  assert.equal(effectiveState(f.chat), "unknown");
  assert.equal(statusLabel(f.chat), "Ended · 3 background observations uncertain");
  f.emit("Stop", { background_tasks: [], session_crons: [] }, 3, "old-clear");
  assert.equal(f.chat.backgroundTasks.length, 2);
  assert.equal(f.chat.scheduledChecks.length, 1);
});

test("malformed and oversized background snapshots fail atomically; providers remain isolated", t => {
  const f = fixture(t, "claude");
  f.emit("Stop", { background_tasks: [{ id: "monitor", type: "monitor" }] }, 2, "valid");
  const before = f.chat;
  const invalid = [
    { background_tasks: [{ id: "missing-type" }] },
    { background_tasks: [{ id: "same", type: "monitor" }, { id: "same", type: "shell" }] },
    { background_tasks: Array.from({ length: 1001 }, (_, i) => ({ id: String(i), type: "monitor" })) },
    { session_crons: {} },
    { session_crons: Array.from({ length: 1001 }, (_, i) => ({ id: String(i), schedule: "0 9 * * *", recurring: true })) },
    { session_crons: Array.from({ length: 2 }, () => ({ id: "same", schedule: "0 9 * * *", recurring: true })) },
    { session_crons: [{ id: "check", schedule: "0 9 * * *", recurring: "yes" }] },
    { background_tasks: [], session_crons: [{ id: "check", recurring: true }] },
  ];
  for (const [i, payload] of invalid.entries()) {
    assert.throws(() => f.emit("Stop", payload, 3, `invalid-${i}`));
    assert.deepEqual(f.chat, before);
    assert.equal(f.store.db.prepare("SELECT 1 FROM processed_events WHERE eventId=?").get(`invalid-${i}`), undefined);
  }
  f.store.command({ type: "createSource", name: "Other", provider: "claude", environment: "native" });
  const other = f.store.sources().find(s => s.id !== f.source.id)!;
  f.store.ingest(other.id, { version: 1, eventId: "other-prompt", payload: { hook_event_name: "UserPromptSubmit", session_id: "parent" } });
  f.store.ingest(other.id, { version: 1, eventId: "other-stop", payload: { hook_event_name: "Stop", session_id: "parent", background_tasks: [] } });
  assert.deepEqual(f.chat, before);
  const codex = { ...f.source, provider: "codex" as const };
  assert.equal(normalize(codex, { hook_event_name: "Stop", session_id: "parent", session_crons: [{ id: "unsupported" }] })!.scheduledChecks, undefined);
});

test("v8 migration preserves response links and user data without fabricating monitoring", t => {
  const f = fixture(t, "claude");
  f.store.command({ type: "updateChat", id: f.id, patch: { name: "Watch CI", notes: "Keep migration notes", archived: true } });
  f.emit("Stop", { last_assistant_message: "[Build](https://ci.example/build/42)" });
  const before = f.chat;
  const links = f.store.links();
  assert.equal(links.length, 1);
  f.store.db.exec("DROP TABLE plan_wrapups; DROP TABLE plan_drafts; DROP TABLE plan_undo; DROP TABLE chat_rounds; DROP TABLE plan_chats; DROP TABLE plan_entries; DROP TABLE plan_imports; DROP TABLE plan_items; DROP TABLE background_snapshots; PRAGMA user_version=8;");
  f.reopen();
  assert.deepEqual(f.chat, {...before, latestRound: null});
  assert.deepEqual(f.store.links(), links);
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 11);
  assert.deepEqual(f.store.db.pragma("foreign_key_check"), []);
  f.reopen();
  assert.equal(readdirSync(f.dir).filter(name => name.includes(".bak-")).length, 1);
});
