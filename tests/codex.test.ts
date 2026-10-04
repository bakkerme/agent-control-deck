import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookReceiver } from "../src/main/http";
import { Store } from "../src/main/store";
import { Inbox } from "../src/main/inbox";
import { sourceSetup, writeHookSetup } from "../src/main/setup";
import { normalize } from "../src/main/providers";

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "acd codex 'hooks "));
  const store = new Store(join(dir, "workspace.sqlite"));
  store.command({ type: "createSource", name: "Codex", provider: "codex", environment: "native" });
  const source = store.sources()[0];
  const inbox = new Inbox(store, dir, () => {});
  const receiver = new HookReceiver(() => ({ store, inbox, root: dir, demo: false }));
  const connection = await receiver.listen({ host: "127.0.0.1", port: 0 });
  const setup = writeHookSetup(dir, source, connection);
  const token = /Authorization: Bearer ([a-f0-9]+)/.exec(setup.testCommand)![1];
  t.after(async () => { await receiver.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const collect = async (hook: string, input: string, status = 200) => {
    const response = await fetch(`${setup.endpoint}/${hook}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: input });
    assert.equal(response.status, status);
    assert.equal(await response.text(), status === 200 && hook === "Stop" ? "{}" : "");
    inbox.poll();
  };
  const emit = (hook: string, extra: Record<string, unknown> = {}) => collect(hook, JSON.stringify({
    hook_event_name: hook, session_id: "codex-session", cwd: "/work/deck", model: "fixture",
    transcript_path: "/absent/transcript.jsonl", ...extra,
  }));
  return { dir, store, source, setup, inbox, collect, emit, connection };
}

test("Codex lifecycle travels through HTTP without steering the agent", async (t) => {
  const f = await fixture(t);
  await f.emit("UserPromptSubmit", { turn_id: "turn-1", prompt: "Build the Codex integration" });
  const id = f.store.chats()[0].id;
  assert.equal(f.store.chat(id).state, "running");
  assert.equal(f.store.chat(id).providerTitle, "Build the Codex integration");
  f.store.command({ type: "updateChat", id, patch: { name: "My Codex chat", notes: "Keep this", projectId: null, archived: true } });
  f.store.ingest(f.source.id, { version: 1, eventId: "legacy-compact", payload: { hook_event_name: "SessionStart", session_id: "codex-session", source: "compact" } });
  assert.equal(f.store.chat(id).state, "running");
  await f.emit("Stop", { turn_id: "turn-1", stop_hook_active: false, last_assistant_message: "Integration ready" });
  assert.equal(f.store.chat(id).state, "idle");
  assert.equal(f.store.chat(id).lifecycle, "open");
  assert.equal(f.store.chat(id).preview, "Integration ready");
  await f.emit("UserPromptSubmit", { turn_id: "turn-2", prompt: "Follow-up prompt" });
  await f.emit("Interrupt", { turn_id: "turn-2" });
  assert.equal(f.store.chat(id).state, "idle");
  assert.equal(f.store.activity(id)[0].summary, "Turn interrupted");
  await f.emit("SessionEnd", { reason: "other" });
  assert.equal(f.store.chat(id).lifecycle, "ended");
  await f.emit("UserPromptSubmit", { prompt: "Resume this chat" });
  const chat = f.store.chat(id);
  assert.equal(chat.lifecycle, "open");
  assert.equal(chat.name, "My Codex chat");
  assert.equal(chat.notes, "Keep this");
  assert.equal(chat.projectId, null);
  assert.equal(chat.archived, true);
  assert.equal(chat.providerTitle, "Build the Codex integration");
  assert.equal(f.store.sources()[0].accepted, 7);
  assert.equal(f.store.sources()[0].rejected, 0);
  assert.equal(readdirSync(f.setup.inbox).length, 0);
  assert.equal(normalize(f.source, { hook_event_name: "Notification" }), null);
  assert.equal(normalize(f.source, { hook_event_name: "StopFailure" }), null);
});

test("Codex configuration uses its own schema, locations, timeouts, and neutral failure output", async (t) => {
  const f = await fixture(t);
  const config = JSON.parse(f.setup.config);
  assert.deepEqual(Object.keys(config.hooks), ["UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"]);
  assert.equal(config.version, undefined);
  assert.ok(f.setup.configFile.includes("~/.codex/hooks.json"));
  assert.ok(f.setup.instructions.includes("/hooks"));
  for (const [event, groups] of Object.entries(config.hooks) as [string, { hooks: { type: string; command: string; timeout: number }[] }[]][]) {
    assert.equal(groups[0].hooks[0].type, "command");
    assert.equal(groups[0].hooks[0].timeout, 3);
  }
  const windows = sourceSetup(f.dir, f.source, "win32", f.connection);
  assert.ok(windows.config.includes("curl.exe"));
  const wsl = sourceSetup(f.dir, { ...f.source, environment: "wsl" }, "win32", f.connection);
  assert.ok(wsl.config.includes("curl.exe "));
  await f.collect("Stop", "{", 400);
  assert.equal(f.store.chats().length, 0);
  await f.collect("Stop", "x".repeat(270000), 413);
  assert.equal(f.store.chats().length, 0);
  f.inbox.test(f.source.id);
  assert.equal(f.store.chats()[0].provider, "codex");
  assert.equal(f.store.chats()[0].projectId, null);
});

test("Codex attachment prompts create useful titles and retain bounded Markdown", async (t) => {
  const f = await fixture(t);
  await f.emit("UserPromptSubmit", { prompt: "# Files mentioned by the user:\n\n## memcard-viewer: /Users/brandon/Library/Mobile Documents/com~apple~CloudDocs/memcard-viewer\n\n<user_query>Fix the **card viewer**\n\n- Keep the layout</user_query>" });
  const chat = f.store.chats()[0];
  assert.equal(chat.providerTitle, "Fix the card viewer - Keep the layout");
  assert.equal(chat.preview, "Fix the **card viewer**\n\n- Keep the layout");
  await f.emit("Stop", { last_assistant_message: "## Fixed\r\n\r\n- **Cards** render\r\n- `paths` work" });
  assert.equal(f.store.chat(chat.id).preview, "## Fixed\n\n- **Cards** render\n- `paths` work");
  await f.emit("Stop", { last_assistant_message: "x".repeat(1000) });
  assert.equal(f.store.chat(chat.id).preview.length, 500);
});
