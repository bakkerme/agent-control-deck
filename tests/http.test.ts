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

function runCommand(command: string, payload = "{}") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // Let Node apply CMD's command-line rules instead of escaping a whole
    // shell command as an ordinary executable argument with escaped quotes.
    const child = spawn(command, { shell: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); });
    child.stdin.end(payload);
  });
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), "acd-http with 'spaces "));
  let store = new Store(join(root, "workspace.sqlite"));
  for (const provider of ["claude", "cursor", "codex"] as const)
    store.command({ type: "createSource", name: provider, provider, environment: provider === "claude" ? "wsl" : "native" });
  let inbox = new Inbox(store, root, () => {});
  let demo = false;
  const receiver = new HookReceiver(() => ({ store, inbox, root, demo }));
  const connection = await receiver.listen({ host: "127.0.0.1", port: 0 });
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

test("Claude answers and tool returns resume the same turn without another prompt", async t => {
  const f = await fixture(t);
  const emit = async (event: string, extra: Record<string, unknown> = {}) => {
    const response = await f.send("claude", event, extra);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), ""); // Observation never directs Claude.
    f.inbox.poll();
  };
  await emit("PostToolUse", { tool_name: "Read" });
  assert.equal(f.store.chats().length, 0); // Tool events don't discover chats.
  await emit("UserPromptSubmit", { prompt: "Build the API" });
  const chat = f.store.chats()[0];
  for (const [event, extra] of [
    ["PostToolUse", { tool_name: "AskUserQuestion", tool_response: { answers: { "Which option?": "First" } } }],
    ["PostToolUse", { tool_name: "Bash" }],
    ["PostToolUseFailure", { tool_name: "Bash", error: "Exit code 1", is_interrupt: false }],
    ["ElicitationResult", { action: "accept", content: { answer: "First" } }],
  ] as const) {
    await emit("Notification", { notification_type: "permission_prompt", message: "Needs input" });
    assert.equal(f.store.chat(chat.id).state, "waiting");
    f.reopen(); // Waiting state and the subsequent resume survive restart.
    await emit(event, extra);
    assert.equal(f.store.chat(chat.id).state, "running");
    assert.equal(f.store.chat(chat.id).lifecycle, "open");
    assert.equal(f.store.chat(chat.id).providerTitle, "Build the API");
    assert.equal(f.store.chat(chat.id).preview, "Build the API");
    assert.equal(f.store.chats().length, 1);
  }
  await emit("PostToolUseFailure", { tool_name: "Bash", is_interrupt: true });
  assert.equal(f.store.chat(chat.id).state, "idle");
  await emit("Stop");
  assert.equal(f.store.chat(chat.id).state, "idle");
  await emit("StopFailure", { error: "API failed" });
  assert.equal(f.store.chat(chat.id).state, "error");
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

test("rejected uploads return an HTTP response while the remaining body is discarded", async t => {
  const f = await fixture(t);
  for (const [headers, status] of [
    [{ Authorization: "" }, 401],
    [{ Authorization: `Bearer ${sourceToken(f.root, f.sources.find(s => s.provider === "claude")!.id)}`, "Content-Length": "270000" }, 413],
  ] as const) {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(`${f.setups.claude.endpoint}/UserPromptSubmit`, { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, res => {
        assert.equal(res.statusCode, status);
        let body = "";
        res.on("data", data => body += data);
        res.on("error", reject);
        res.on("end", () => resolve(body));
        // Finish only after rejection headers arrive, proving that an early
        // response does not reset a client that is still sending its body.
        req.end("x".repeat(270000 - 1));
      });
      req.on("error", reject);
      req.write("x");
    });
    assert.equal(body, "");
  }
  assert.equal(f.store.chats().length, 0);
  assert.equal(readdirSync(f.setups.claude.inbox).length, 0);
});

test("rejected uploads cannot keep sending an unbounded body", async t => {
  const f = await fixture(t);
  await new Promise<void>((resolve, reject) => {
    const req = request(`${f.setups.claude.endpoint}/UserPromptSubmit`, { method: "POST", headers: { "Content-Type": "application/json" } }, res => {
      assert.equal(res.statusCode, 401);
      res.resume();
      res.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
      res.on("close", resolve);
      req.end("x".repeat(600000));
    });
    req.on("error", error => { if (!["ECONNRESET", "EPIPE"].includes((error as NodeJS.ErrnoException).code!)) reject(error); });
    req.write("x");
  });
  assert.equal(f.store.chats().length, 0);
  assert.equal(readdirSync(f.setups.claude.inbox).length, 0);
});

test("generated curl commands deliver stdin through the real shell and return neutral responses", async t => {
  const f = await fixture(t);
  for (const provider of ["claude", "cursor", "codex"] as const) {
    // Exercise payload delivery with the host-native command. WSL path
    // generation is checked separately; this does not exercise interoperability.
    const source = f.sources.find(s => s.provider === provider)!;
    const setup = sourceSetup(f.root, { ...source, environment: "native" }, process.platform, f.connection);
    const event = provider === "cursor" ? "beforeSubmitPrompt" : "UserPromptSubmit";
    const result = await runCommand(setup.testCommand, JSON.stringify({ hook_event_name: event, session_id: "curl-chat", conversation_id: "curl-chat", prompt: "Unicode café 日本語\nSecond line" }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, provider === "cursor" ? '{"continue":true}' : "");
    f.inbox.poll();
  }
  assert.equal(f.store.chats().length, 3);
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

test("subagent HTTP events observe each provider without changing the parent response", async t => {
  const f = await fixture(t);
  for (const provider of ["claude", "cursor", "codex"] as const) {
    const cursor = provider === "cursor";
    const prompt = cursor ? "beforeSubmitPrompt" : "UserPromptSubmit";
    const start = cursor ? "subagentStart" : "SubagentStart";
    const stop = cursor ? "subagentStop" : "SubagentStop";
    const identity = cursor ? { subagent_id: "worker", parent_conversation_id: "already-existing-chat", conversation_id: "child" } : { agent_id: "worker" };
    assert.equal((await f.send(provider, prompt, { prompt: "Parent request" })).status, 200);
    f.inbox.poll();
    const startResponse = await f.send(provider, start, identity);
    assert.equal(startResponse.status, 200);
    assert.equal(await startResponse.text(), cursor ? '{"permission":"allow"}' : "");
    f.inbox.poll();
    const chat = () => f.store.chats().find(c => c.provider === provider)!;
    assert.equal(chat().subagents.length, 1);
    assert.equal((await f.send(provider, cursor ? "stop" : "Stop", { last_assistant_message: "Main response" })).status, 200);
    f.inbox.poll();
    assert.equal(chat().state, "idle");
    assert.equal(chat().subagents.length, 1);
    const stopResponse = await f.send(provider, stop, { ...identity, last_assistant_message: "Child response", ...(provider === "claude" ? { background_tasks: [] } : {}) });
    assert.equal(stopResponse.status, 200);
    assert.equal(await stopResponse.text(), provider === "codex" ? "{}" : "");
    f.inbox.poll();
    assert.equal(chat().subagents.length, 0);
    assert.equal(chat().preview, "Main response");
    assert.equal((await f.send(provider, start, { ...identity, agent_id: "", subagent_id: "" })).status, 400);
  }
  assert.equal(f.store.chats().length, 3);
});

test("command hooks remain quiet and neutral when delivery fails; diagnostics still report failure", async t => {
  const f = await fixture(t);
  for (const provider of ["claude", "cursor", "codex"] as const) {
    // WSL's POSIX wrapper is exercised on macOS using host curl. Native Windows
    // command hooks are exercised by cmd.exe; actual WSL interoperability is not.
    if (process.platform === "win32" && provider === "claude") continue;
    const source = f.sources.find(s => s.provider === provider)!;
    const setup = sourceSetup(f.root, { ...source, environment: provider === "claude" ? "wsl" : "native" }, provider === "claude" ? "win32" : process.platform, f.connection);
    const config = JSON.parse(setup.config);
    for (const [event, groups] of Object.entries(config.hooks) as [string, { command?: string; hooks?: { command: string }[] }[]][]) {
      const hook = provider === "cursor" ? groups[0] : groups[0].hooks![0];
      const command = hook.command!.replace('"/mnt/c/Windows/System32/curl.exe"', "curl");
      const neutral = provider === "cursor" && event === "beforeSubmitPrompt" ? '{"continue":true}' : provider === "cursor" && event === "subagentStart" ? '{"permission":"allow"}' : provider === "codex" && (event === "Stop" || event === "SubagentStop") ? "{}" : "";
      const assertNeutral = (result: Awaited<ReturnType<typeof runCommand>>) => {
        assert.equal(result.code, 0);
        assert.equal(result.stdout.trim(), neutral);
        assert.equal(result.stderr, "");
      };
      // A live receiver refusing the payload must not affect the agent.
      assertNeutral(await runCommand(command));
      // Missing curl (including a wrong WSL mount path) is also fail-open.
      assertNeutral(await runCommand(command.replace(/^curl(?:\.exe)? /, "acd-no-such-curl ")));
      // Use an unbound loopback port to exercise a closed deck without changing
      // the fixture's live receiver or depending on an arbitrary port number.
      const closed = new HookReceiver(() => ({ store: f.store, inbox: f.inbox, root: f.root, demo: false }));
      const address = await closed.listen({ host: "127.0.0.1", port: 0 });
      await closed.close();
      assertNeutral(await runCommand(command.replace(f.connection.url, address.url)));
      assert.notEqual((await runCommand(setup.testCommand.replace('"/mnt/c/Windows/System32/curl.exe"', "curl").replace(f.connection.url, address.url))).code, 0);
    }
  }
  assert.equal(f.store.chats().length, 0);
});

test("Windows WSL hooks use Windows curl and receiver address, preserving credentials across restart", async t => {
  const f = await fixture(t);
  const source = f.sources.find(s => s.provider === "claude")!;
  const setup = sourceSetup(f.root, source, "win32", f.connection);
  const config = JSON.parse(setup.config);
  assert.deepEqual(Object.keys(config.hooks), ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "Notification", "PostToolUse", "PostToolUseFailure", "ElicitationResult", "SubagentStart", "SubagentStop"]);
  for (const groups of Object.values(config.hooks) as { hooks: { type: string; command: string; url?: string }[] }[][]) {
    const hook = groups[0].hooks[0];
    assert.equal(hook.type, "command");
    assert.ok(hook.command.startsWith('"/mnt/c/Windows/System32/curl.exe" '));
    assert.ok(hook.command.includes(`${f.connection.url}/hooks/${source.id}/`));
    assert.ok(hook.command.includes('--data-binary "@-"'));
    assert.equal(hook.url, undefined);
  }
  assert.ok(setup.endpoint.startsWith(f.connection.url));
  assert.ok(!setup.config.includes("powershell") && !setup.config.includes("wslpath"));
  assert.ok(setup.testCommand.startsWith('"/mnt/c/Windows/System32/curl.exe" '));
  assert.ok(setup.instructions.includes("without requiring Windows directories on your WSL PATH"));
  f.reopen();
  assert.equal(sourceSetup(f.root, source, "win32", f.connection).config, setup.config);
  // Native Claude keeps direct HTTP. Other Windows WSL providers use the same
  // Windows curl transport, keeping tokens and source identities separate.
  const native = JSON.parse(sourceSetup(f.root, { ...source, environment: "native" }, "win32", f.connection).config);
  assert.equal(native.hooks.UserPromptSubmit[0].hooks[0].type, "http");
  for (const provider of ["cursor", "codex"] as const) {
    const other = f.sources.find(s => s.provider === provider)!;
    const configured = JSON.parse(sourceSetup(f.root, { ...other, environment: "wsl" }, "win32", f.connection).config);
    const groups = configured.hooks[provider === "cursor" ? "beforeSubmitPrompt" : "UserPromptSubmit"];
    assert.ok((provider === "cursor" ? groups[0] : groups[0].hooks[0]).command.startsWith('"/mnt/c/Windows/System32/curl.exe" '));
  }
  assert.throws(() => hookOrigin('http://host/$(danger)'));
  assert.throws(() => hookOrigin("https://example.com"));
  assert.throws(() => receiverOptions({ ACD_HTTP_HOST: "example.com" }));
  assert.throws(() => receiverOptions({ ACD_HTTP_PORT: "bad" }));
  assert.deepEqual(receiverOptions({ ACD_WSL_HOOK_URL: "http://172.30.0.1:43821" }), { host: "127.0.0.1", port: 43821 });
});
