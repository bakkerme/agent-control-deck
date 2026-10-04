import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { Inbox } from "../src/main/inbox";
import { sourceSetup, writeHookSetup } from "../src/main/setup";

test("inbox tolerates partial/malformed files, replays after restart, and consumes atomic HTTP queue output", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "acd inbox with spaces "));
  const store = new Store(join(dir, "workspace.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.command({
    type: "createSource",
    name: "Cursor",
    provider: "cursor",
    environment: "native",
  });
  const source = store.sources()[0];
  const setup = writeHookSetup(dir, source);
  let notifications = 0;
  const inbox = new Inbox(store, dir, () => notifications++);
  writeFileSync(join(setup.inbox, "partial.tmp"), "{");
  writeFileSync(join(setup.inbox, "broken.json"), "{");
  const payload = {
    version: 1,
    eventId: "valid",
    payload: {
      conversation_id: "first",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "A task",
      workspace_roots: ["/demo/api"],
    },
  };
  writeFileSync(join(setup.inbox, "valid.tmp"), JSON.stringify(payload));
  inbox.poll();
  assert.equal(store.chats().length, 0);
  assert.equal(store.sources()[0].rejected, 1);
  renameSync(join(setup.inbox, "valid.tmp"), join(setup.inbox, "valid.json"));
  inbox.poll();
  assert.equal(store.chats().length, 1);
  assert.equal(existsSync(join(setup.inbox, "valid.json")), false);
  writeFileSync(join(setup.inbox, "replay.json"), JSON.stringify(payload));
  inbox.poll();
  assert.equal(store.activity(store.chats()[0].id).length, 1);
  const input = JSON.stringify({
    conversation_id: "wrapper",
    hook_event_name: "beforeSubmitPrompt",
    prompt: "Written by HTTP queue",
    workspace_roots: ["/demo/api"],
  });
  inbox.enqueue(source.id, { version: 1, eventId: "queued", payload: JSON.parse(input) });
  inbox.poll();
  assert.equal(store.chats().length, 2);
  assert.ok(notifications > 0);
  assert.equal(
    readdirSync(setup.inbox).filter((n) => n.endsWith(".json")).length,
    0,
  );
});
test("disabled sources retain pending events and malformed oversized payloads do not stop processing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "acd-pause-"));
  const store = new Store(join(dir, "workspace.sqlite"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.command({
    type: "createSource",
    name: "Claude WSL",
    provider: "claude",
    environment: "wsl",
  });
  const source = store.sources()[0];
  const setup = writeHookSetup(dir, source);
  const inbox = new Inbox(store, dir, () => {});
  store.command({ type: "updateSource", id: source.id, enabled: false });
  const path = join(setup.inbox, "large.json");
  writeFileSync(path, "x".repeat(262145));
  inbox.poll();
  assert.ok(existsSync(path));
  store.command({ type: "updateSource", id: source.id, enabled: true });
  inbox.poll();
  assert.equal(existsSync(path), false);
  assert.equal(store.sources()[0].rejected, 1);
  inbox.test(source.id);
  assert.equal(store.chats().length, 1);
  const config = sourceSetup(
    dir,
    source,
    "win32",
  ).config;
  assert.ok(config.includes("http://127.0.0.1"));
  assert.ok(config.includes("UserPromptSubmit"));
  assert.ok(!config.includes("SessionStart"));
  assert.ok(!config.includes("PreToolUse"));
});
