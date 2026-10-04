import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { HookReceiver, receiverOptions } from "../src/main/http";
import { Store } from "../src/main/store";
import { Inbox } from "../src/main/inbox";
import { sourceSetup, writeHookSetup, sourceToken, hookOrigin } from "../src/main/setup";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "acd-http with 'spaces "));
  let store = new Store(join(root, "workspace.sqlite"));
  for (const provider of ["claude", "cursor", "codex"] as const)
    store.command({ type: "createSource", name: provider, provider, environment: provider === "claude" ? "wsl" : "native" });
  let inbox = new Inbox(store, root, () => {});
  let demo = false;
  const receiver = new HookReceiver(() => ({ store, inbox, root, demo }));
  const connection = await receiver.listen({ host: "127.0.0.1", port: 0, wslUrl: undefined });
  const sources = store.sources();
  const setups = Object.fromEntries(sources.map(s => [s.provider, writeHookSetup(root, s, connection)]));
  t.after(async () => { await receiver.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const send = (provider: string, event: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const source = sources.find(s => s.provider === provider)!;
    return fetch(`${setups[provider].endpoint}/${event}`, {
      method: "POST", headers: { Authorization: `Bearer ${sourceToken(root, source.id)}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ hook_event_name: event, ...(provider === "cursor" ? { conversation_id: "already-existing-chat" } : { session_id: "already-existing-chat" }), cwd: "/home/me/work", ...extra }),
    });
  };
  return { root, sources, setups, connection, receiver, send, get store() { return store; }, get inbox() { return inbox; },
    setDemo(value: boolean) { demo = value; },
    reopen() { store.close(); store = new Store(join(root, "workspace.sqlite")); inbox = new Inbox(store, root, () => {}); },
  };
}

test("HTTP discovers existing chats on first prompt and preserves edits through pause, restart and resume", async t => {
  const f = await fixture(t);
  assert.equal((await f.send("claude", "SessionEnd")).status, 200);
  assert.equal((await f.send("claude", "Notification", { notification_type: "idle_prompt" })).status, 200);
  f.inbox.poll();
  assert.equal(f.store.chats().length, 0);
  assert.equal(f.store.projects().length, 0);
  assert.equal((await f.send("claude", "UserPromptSubmit", { prompt: "Continue an existing chat" }, { "X-Deck-Event-Id": "first-prompt" })).status, 200);
  f.inbox.poll();
  const chat = f.store.chats()[0];
  assert.equal(chat.state, "running");
  assert.equal(chat.providerTitle, "Continue an existing chat");
  f.store.command({ type: "updateChat", id: chat.id, patch: { name: "Work task", notes: "Keep this", archived: true, projectId: null, jiraKey: "WORK-1" } });
  const source = f.sources.find(s => s.provider === "claude")!;
  f.store.command({ type: "updateSource", id: source.id, enabled: false });
  assert.equal((await f.send("claude", "Stop", { last_assistant_message: "Ready" })).status, 200);
  f.inbox.poll();
  assert.equal(readdirSync(f.setups.claude.inbox).length, 1);
  assert.equal(f.store.chat(chat.id).state, "running");
  f.reopen();
  f.store.command({ type: "updateSource", id: source.id, enabled: true });
  f.inbox.poll();
  assert.equal(f.store.chat(chat.id).state, "idle");
  assert.equal((await f.send("claude", "UserPromptSubmit", { prompt: "Duplicate" }, { "X-Deck-Event-Id": "first-prompt" })).status, 200);
  f.inbox.poll();
  assert.equal(f.store.chat(chat.id).state, "idle");
  await f.send("claude", "SessionEnd"); f.inbox.poll();
  await f.send("claude", "UserPromptSubmit", { prompt: "Resume work" }); f.inbox.poll();
  assert.equal(f.store.chats().length, 1);
  assert.equal(f.store.chat(chat.id).lifecycle, "open");
  assert.equal(f.store.chat(chat.id).name, "Work task");
  assert.equal(f.store.chat(chat.id).notes, "Keep this");
  assert.equal(f.store.chat(chat.id).archived, true);
  assert.equal(f.store.chat(chat.id).projectId, null);
  assert.equal(f.store.chat(chat.id).jiraKey, "WORK-1");
});

test("HTTP rejects unauthorized, cross-source, browser, mismatched and oversized requests; isolates demo", async t => {
  const f = await fixture(t);
  assert.equal((await f.send("claude", "UserPromptSubmit", {}, { Authorization: "" })).status, 401);
  const cursor = f.sources.find(s => s.provider === "cursor")!;
  assert.equal((await f.send("claude", "UserPromptSubmit", {}, { Authorization: `Bearer ${sourceToken(f.root, cursor.id)}` })).status, 401);
  assert.equal((await f.send("claude", "UserPromptSubmit", {}, { Origin: "https://example.com" })).status, 403);
  assert.equal((await f.send("claude", "SessionStart")).status, 404);
  assert.equal((await f.send("claude", "UserPromptSubmit", { hook_event_name: "Stop" })).status, 400);
  assert.equal((await f.send("claude", "UserPromptSubmit", { session_id: "" })).status, 400);
  assert.equal((await f.send("claude", "UserPromptSubmit", { prompt: "x".repeat(262144) })).status, 413);
  assert.equal((await f.send("claude", "UserPromptSubmit", {}, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await fetch(f.setups.claude.endpoint)).status, 405);
  f.setDemo(true);
  assert.equal((await f.send("claude", "UserPromptSubmit")).status, 503);
  f.setDemo(false);
  // The streaming limit also applies without a Content-Length header.
  const result = await new Promise<number>((resolve, reject) => {
    const source = f.sources.find(s => s.provider === "claude")!;
    const req = request(`${f.setups.claude.endpoint}/UserPromptSubmit`, { method: "POST", headers: { Authorization: `Bearer ${sourceToken(f.root, source.id)}`, "Content-Type": "application/json" } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on("error", reject); req.write("x".repeat(262145)); req.end();
  });
  assert.equal(result, 413);
  assert.equal(f.store.chats().length, 0);
  assert.equal(readdirSync(f.setups.claude.inbox).length, 0);
});

test("generated curl commands deliver stdin through the real shell and return neutral responses", async t => {
  const f = await fixture(t);
  for (const provider of ["cursor", "codex"] as const) {
    const config = JSON.parse(f.setups[provider].config);
    const event = provider === "cursor" ? "beforeSubmitPrompt" : "UserPromptSubmit";
    const hook = provider === "cursor" ? config.hooks[event][0] : config.hooks[event][0].hooks[0];
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32" ? ["/d", "/s", "/c", hook.command] : ["-c", hook.command]);
      let stdout = ""; child.stdout.on("data", data => stdout += data);
      child.on("error", reject); child.on("close", code => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: "curl-chat", conversation_id: "curl-chat", prompt: "Unicode café 日本語\nSecond line" }));
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, provider === "cursor" ? '{"continue":true}' : "");
    f.inbox.poll();
  }
  assert.equal(f.store.chats().length, 2);
  assert.ok(f.store.chats().every(chat => chat.preview === "Unicode café 日本語\nSecond line"));
  assert.equal(await (await f.send("codex", "Stop")).text(), "{}");
  assert.equal(await (await f.send("cursor", "stop", { status: "completed" })).text(), "");
});

test("queued HTTP events survive database failure and a full queue refuses acceptance", async t => {
  const f = await fixture(t);
  const original = f.store.ingest.bind(f.store);
  f.store.ingest = () => { throw Object.assign(new Error("Disk failure"), { code: "SQLITE_IOERR" }); };
  assert.equal((await f.send("claude", "UserPromptSubmit", { prompt: "Queued" })).status, 200);
  f.inbox.poll();
  assert.equal(readdirSync(f.setups.claude.inbox).length, 1);
  f.store.ingest = original;
  f.inbox.poll();
  assert.equal(f.store.chats()[0].providerTitle, "Queued");
  for (let i = 0; i < 1000; i++) writeFileSync(join(f.setups.claude.inbox, `${i}.json`), "{}");
  assert.equal((await f.send("claude", "UserPromptSubmit")).status, 503);
  assert.equal(readdirSync(f.setups.claude.inbox).length, 1000);
});

test("HTTP configuration persists credentials and supports explicit WSL host routing without scripts", async t => {
  const f = await fixture(t);
  const source = f.sources.find(s => s.provider === "claude")!;
  const setup = sourceSetup(f.root, source, "win32", { url: f.connection.url, wslUrl: "http://172.30.0.1:43821" });
  const config = JSON.parse(setup.config);
  assert.deepEqual(Object.keys(config.hooks), ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "Notification"]);
  assert.equal(config.hooks.UserPromptSubmit[0].hooks[0].type, "http");
  assert.ok(setup.endpoint.startsWith("http://172.30.0.1:43821/"));
  assert.ok(!setup.config.includes("powershell") && !setup.config.includes("wslpath") && !setup.config.includes("command"));
  f.reopen();
  assert.equal(sourceSetup(f.root, source, "win32", { url: f.connection.url, wslUrl: "http://172.30.0.1:43821" }).config, setup.config);
  assert.throws(() => hookOrigin('http://host/$(danger)'));
  assert.throws(() => hookOrigin("https://example.com"));
  assert.throws(() => receiverOptions({ ACD_HTTP_HOST: "example.com" }));
  assert.throws(() => receiverOptions({ ACD_HTTP_PORT: "bad" }));
});
