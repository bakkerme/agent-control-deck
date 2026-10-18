import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../src/main/store";
import { PlanningStore } from "../src/main/planning-store";
import { embeddedConfig } from "../src/main/embedded-config";
import { EmbeddedChats } from "../src/main/embedded-chat";
import type { AgentRunner } from "../src/main/embedded-sdk";
const sessionId = "11111111-1111-4111-8111-111111111111";
const sdk = (value: unknown) => value as SDKMessage;
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate: () => boolean | Promise<boolean>) { for (let i = 0; i < 200; i++) { if (await predicate()) return; await tick(); } assert.fail("Lifecycle checkpoint timed out"); }
function fixture(t: { after(fn: () => void): void }, runner: AgentRunner, key: string | undefined = "synthetic-test-key") {
  const dir = mkdtempSync(join(tmpdir(), "acd-embedded-"));
  let store = new Store(join(dir, "workspace.sqlite"));
  let service = new EmbeddedChats(store, dir, () => {}, true, runner, embeddedConfig({ ACD_EMBEDDED_AUTH: "api-key", ANTHROPIC_API_KEY: key }));
  store.command({ type: "createPlanItem", day: "2026-10-18", category: "Other", name: "Synthetic research" });
  const taskId = new PlanningStore(store).items()[0].id;
  t.after(() => { service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, taskId, get store() { return store; }, get service() { return service; },
    async create() { return (await service.command({ type: "create", taskId, cwd: dir, name: "Synthetic agent" })).chat!; },
    async read(chatId: string) { return (await service.command({ type: "read", chatId })).chat!; },
    reopen() { service.close(); store.close(); store = new Store(join(dir, "workspace.sqlite")); service = new EmbeddedChats(store, dir, () => {}, true, runner, embeddedConfig({ ACD_EMBEDDED_AUTH: "api-key", ANTHROPIC_API_KEY: key })); },
  };
}
test("task links, streamed block reconciliation, resume and normal workflow survive restart", async t => {
  const options: Options[] = [];
  const runner: AgentRunner = async (_prompt, opts) => {
    options.push(opts);
    return { close() {}, async *[Symbol.asyncIterator]() {
      yield sdk({ type: "system", subtype: "init", session_id: sessionId });
      yield sdk({ type: "stream_event", session_id: sessionId, parent_tool_use_id: null, event: { type: "message_start", message: { id: "message-1" } } });
      yield sdk({ type: "stream_event", session_id: sessionId, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } } });
      yield sdk({ type: "assistant", uuid: "assistant-fixture", session_id: sessionId, message: { id: "message-1", content: [{ type: "text", text: "Hello world" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "example.txt" } }] } });
      yield sdk({ type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "synthetic result" }] } });
      yield sdk({ type: "result", session_id: sessionId, is_error: false, subtype: "success" });
    } };
  };
  const f = fixture(t, runner), chat = await f.create();
  assert.ok(new PlanningStore(f.store).items()[0].chatIds.includes(chat.chatId));
  assert.equal(f.store.chat(chat.chatId).provider, "claude");
  await f.service.command({ type: "send", sendId: randomUUID(), chatId: chat.chatId, text: "Synthetic prompt" });
  await until(async () => !(await f.read(chat.chatId)).active);
  const complete = await f.read(chat.chatId);
  assert.equal(complete.state, "idle");
  assert.equal(complete.events.filter(e => e.kind === "assistant").length, 1);
  assert.equal(complete.events.find(e => e.kind === "assistant")?.text, "Hello world");
  assert.equal(complete.events.filter(e => e.kind === "tool").length, 2);
  assert.equal(complete.sessionId, sessionId);
  assert.deepEqual(options[0].settingSources, []);
  assert.equal(options[0].permissionMode, "default");
  assert.equal(options[0].env?.ANTHROPIC_API_KEY, "synthetic-test-key");
  assert.equal(options[0].env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  f.store.command({ type: "updateChat", id: chat.chatId, patch: { notes: "Keep human notes", name: "Renamed" } });
  f.reopen();
  assert.equal((await f.read(chat.chatId)).events.length, complete.events.length);
  await f.service.command({ type: "send", sendId: randomUUID(), chatId: chat.chatId, text: "Continue" });
  await until(async () => !(await f.read(chat.chatId)).active);
  assert.equal(options[1].resume, sessionId);
  assert.equal(f.store.chat(chat.chatId).notes, "Keep human notes");
  assert.equal((await f.service.command({ type: "list", taskId: f.taskId })).chats?.[0].name, "Renamed");
  f.store.command({ type: "setPlanChats", id: f.taskId, chatIds: [] });
  assert.equal((await f.service.command({ type: "list", taskId: f.taskId })).chats?.length, 0);
  f.store.command({ type: "setPlanChats", id: f.taskId, chatIds: [chat.chatId] });
  assert.equal((await f.service.command({ type: "list", taskId: f.taskId })).chats?.length, 1);
});
test("tool approvals require an exact pending request; questions and cancellation deny safely", async t => {
  const decisions: PermissionResult[] = [];
  const runner: AgentRunner = async (_prompt, options) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const hook = options.hooks!.PreToolUse![0].hooks[0];
    const gate = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "tool", session_id: sessionId, transcript_path: "", cwd: "/tmp" }, "tool", { signal: options.abortController!.signal });
    assert.equal((gate as any).hookSpecificOutput.permissionDecision, "ask");
    const ask = (tool: string, input: Record<string, unknown>) => options.canUseTool!(tool, input, { signal: options.abortController!.signal, toolUseID: "tool", requestId: "sdk-request" });
    decisions.push((await ask("Bash", { command: "echo synthetic" }))!);
    decisions.push((await ask("AskUserQuestion", { questions: [{ question: "Which path?", header: "Path", options: [{ label: "A" }, { label: "B" }] }] }))!);
    decisions.push((await ask("Write", { file_path: "example.txt", content: "synthetic" }))!);
    yield sdk({ type: "result", session_id: sessionId, is_error: false, subtype: "success" });
  } });
  const f = fixture(t, runner), chat = await f.create();
  await f.service.command({ type: "send", sendId: randomUUID(), chatId: chat.chatId, text: "Check" });
  await until(async () => (await f.read(chat.chatId)).requests.length > 0);
  const first = (await f.read(chat.chatId)).requests[0];
  assert.equal(f.store.chat(chat.chatId).state, "waiting");
  await assert.rejects(f.service.command({ type: "send", sendId: randomUUID(), chatId: chat.chatId, text: "Duplicate" }), /current turn/);
  await assert.rejects(f.service.command({ type: "decide", chatId: chat.chatId, requestId: "stale", allow: true }), /expired/);
  await f.service.command({ type: "decide", chatId: chat.chatId, requestId: first.id, allow: false });
  await until(async () => (await f.read(chat.chatId)).requests[0]?.tool === "AskUserQuestion");
  const question = (await f.read(chat.chatId)).requests[0];
  await assert.rejects(f.service.command({ type: "decide", chatId: chat.chatId, requestId: question.id, allow: true, answers: {} }), /Answer each/);
  await f.service.command({ type: "decide", chatId: chat.chatId, requestId: question.id, allow: true, answers: { "Which path?": "B" } });
  await until(async () => (await f.read(chat.chatId)).requests[0]?.tool === "Write");
  const write = (await f.read(chat.chatId)).requests[0];
  await f.service.command({ type: "cancel", chatId: chat.chatId });
  await until(async () => !(await f.read(chat.chatId)).active);
  assert.equal(decisions[0].behavior, "deny");
  assert.deepEqual(decisions[1].behavior === "allow" && decisions[1].updatedInput?.answers, { "Which path?": "B" });
  assert.equal(decisions[2].behavior, "deny");
  await assert.rejects(f.service.command({ type: "decide", chatId: chat.chatId, requestId: write.id, allow: true }), /expired/);
  assert.match((await f.read(chat.chatId)).events.at(-1)!.text, /cancelled/);
});
test("errors remain resumable, missing auth is explicit, invalid input and disabled mode are rejected", async t => {
  const f = fixture(t, async () => { throw new Error("synthetic secret error"); });
  const chat = await f.create();
  await f.service.command({ type: "send", sendId: randomUUID(), chatId: chat.chatId, text: "Hello" });
  await until(async () => !(await f.read(chat.chatId)).active);
  assert.equal((await f.read(chat.chatId)).state, "error");
  assert.ok(!(await f.read(chat.chatId)).events.some(e => e.text.includes("synthetic secret error")));
  await assert.rejects(f.service.command({ type: "create", taskId: f.taskId, cwd: "relative", name: "Bad" }), /absolute/);
  await assert.rejects(f.service.command({ type: "read", chatId: "not-embedded" }), /embedded chat/);
  const noAuth = new EmbeddedChats(f.store, f.dir, () => {}, true, async () => { throw new Error("must not run"); }, embeddedConfig({ ACD_EMBEDDED_AUTH: "api-key" }));
  await assert.rejects(noAuth.command({ type: "send", sendId: randomUUID(), chatId: chat.chatId, text: "Hi" }), /ANTHROPIC_API_KEY/);
  noAuth.close();
  const disabled = new EmbeddedChats(f.store, f.dir, () => {}, false);
  await assert.rejects(disabled.command({ type: "read", chatId: chat.chatId }), /disabled/);
  assert.equal((await disabled.command({ type: "status" })).enabled, false);
  disabled.close();
});
test("restart marks interrupted work idle and retains transcript plus durable task association", async t => {
  const f = fixture(t, async () => ({ close() {}, async *[Symbol.asyncIterator]() {} })), chat = await f.create();
  f.store.db.prepare("UPDATE chats SET state='waiting' WHERE id=?").run(chat.chatId);
  f.reopen();
  const restored = await f.read(chat.chatId);
  assert.equal(restored.state, "idle");
  assert.equal(restored.requests.length, 0);
  assert.match(restored.events[0].text, /restarted/);
  assert.ok(new PlanningStore(f.store).items()[0].chatIds.includes(chat.chatId));
});
test("SDK single-block envelopes reconcile actual stream indices after thinking and retain multiple text blocks", async t => {
  const runner: AgentRunner = async () => ({ close() {}, async *[Symbol.asyncIterator]() {
    yield sdk({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "multi" } } });
    yield sdk({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    yield sdk({ type: "assistant", uuid: "thinking-frame", message: { id: "multi", content: [{ type: "thinking", thinking: "hidden" }] } });
    for (const [index, text] of [[1, "First text"], [2, "Second text"]] as const) {
      yield sdk({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
      yield sdk({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index, delta: { type: "text_delta", text: text.slice(0, 5) } } });
      yield sdk({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index } });
      const complete = sdk({ type: "assistant", uuid: `frame-${index}`, message: { id: "multi", content: [{ type: "text", text }] } });
      yield complete; yield complete; // duplicate delivery must not duplicate or consume another block
    }
    yield sdk({ type: "result", is_error: false, subtype: "success" });
  } });
  const f = fixture(t, runner), chat = await f.create();
  await f.service.command({ type: "send", sendId: randomUUID(), chatId: chat.chatId, text: "Synthetic" });
  await until(async () => !(await f.read(chat.chatId)).active);
  assert.deepEqual((await f.read(chat.chatId)).events.filter(e => e.kind === "assistant").map(e => [e.id, e.text]), [["multi:1", "First text"], ["multi:2", "Second text"]]);
});
test("stop releases even an unresponsive iterator; late completion cannot mutate a subsequent turn", async t => {
  let resolveLate: ((value: IteratorResult<SDKMessage>) => void) | undefined, calls = 0, closed = 0;
  const runner: AgentRunner = async () => {
    calls++;
    if (calls === 1) return { close() { closed++; }, [Symbol.asyncIterator]() { return { next() { return new Promise(resolve => { resolveLate = resolve; }); } }; } };
    return { close() { closed++; }, async *[Symbol.asyncIterator]() { yield sdk({ type: "result", is_error: false, subtype: "success" }); } };
  };
  const f = fixture(t, runner), chat = await f.create();
  await f.service.command({ type: "send", sendId: randomUUID(), chatId: chat.chatId, text: "First" });
  await until(() => !!resolveLate);
  await f.service.command({ type: "cancel", chatId: chat.chatId });
  await until(async () => !(await f.read(chat.chatId)).active);
  await f.service.command({ type: "send", sendId: randomUUID(), chatId: chat.chatId, text: "Second" });
  await until(async () => !(await f.read(chat.chatId)).active);
  resolveLate!({ done: false, value: sdk({ type: "assistant", uuid: "late", message: { id: "late", content: [{ type: "text", text: "Stale output" }] } }) });
  await tick();
  assert.equal((await f.read(chat.chatId)).state, "idle");
  assert.ok(!(await f.read(chat.chatId)).events.some(e => e.text === "Stale output"));
  assert.ok(closed >= 2);
});
test("oversized permission inputs are denied, and same-folder tasks resume their exact separate sessions", async t => {
  let turn = 0;
  const seen: (string | undefined)[] = [];
  const runner: AgentRunner = async (_prompt, options) => {
    const number = ++turn; seen.push(options.resume);
    return { close() {}, async *[Symbol.asyncIterator]() {
      const result = await options.canUseTool!("Bash", { command: "x".repeat(31000) }, { signal: options.abortController!.signal, requestId: "oversize", toolUseID: "oversize" });
      assert.equal(result?.behavior, "deny");
      yield sdk({ type: "result", session_id: options.resume ?? `synthetic-session-${number}`, is_error: false, subtype: "success" });
    } };
  };
  const f = fixture(t, runner), first = await f.create();
  f.store.command({ type: "createPlanItem", day: "2026-10-18", category: "Other", name: "Second synthetic task" });
  const secondTask = new PlanningStore(f.store).items().find(task => task.id !== f.taskId)!;
  const second = (await f.service.command({ type: "create", taskId: secondTask.id, cwd: f.dir, name: "Second chat" })).chat!;
  for (const chat of [first, second, first, second]) {
    await f.service.command({ type: "send", sendId: randomUUID(), chatId: chat.chatId, text: "Synthetic" });
    await until(async () => !(await f.read(chat.chatId)).active);
  }
  assert.deepEqual(seen, [undefined, undefined, "synthetic-session-1", "synthetic-session-2"]);
});
test("retried app send IDs never resubmit a turn, including after restart", async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return { close() {}, async *[Symbol.asyncIterator]() { yield sdk({ type: "result", is_error: false, subtype: "success" }); } }; });
  const chat = await f.create(), sendId = randomUUID();
  const send = { type: "send", sendId, chatId: chat.chatId, text: "Synthetic idempotent request" };
  await f.service.command(send);
  await until(async () => !(await f.read(chat.chatId)).active);
  f.reopen();
  await f.service.command(send);
  assert.equal(calls, 1);
  assert.equal((await f.read(chat.chatId)).events.filter(e => e.kind === "user").length, 1);
  await assert.rejects(f.service.command({ ...send, text: "Different" }), /different message/);
});

test("OpenRouter propagates backend-only options, proxy and role models without persisting credentials", async t => {
  let options: Options | undefined;
  const f = fixture(t, async () => { throw new Error("unused"); });
  f.service.close();
  const credential = "synthetic-openrouter-credential";
  const config = embeddedConfig({ ACD_EMBEDDED_PROVIDER: "openrouter", ANTHROPIC_AUTH_TOKEN: credential, ANTHROPIC_API_KEY: "wrong-provider-key", HTTPS_PROXY: "http://proxy.invalid:8080", NODE_USE_ENV_PROXY: "1", CLAUDE_CODE_OAUTH_TOKEN: "unrelated", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-unwanted" });
  const service = new EmbeddedChats(f.store, f.dir, () => {}, true, async (_text, opts) => {
    options = opts;
    return { close() {}, async *[Symbol.asyncIterator]() {
      const decision = await opts.canUseTool!("AskUserQuestion", { questions: [{ question: credential, header: "Synthetic", options: [{ label: "A" }] }] }, { signal: opts.abortController!.signal, toolUseID: "synthetic", requestId: "synthetic" });
      assert.equal(decision?.behavior, "deny");
      yield sdk({ type: "assistant", uuid: "synthetic", message: { id: "synthetic", content: [{ type: "text", text: credential }] } });
      yield sdk({ type: "result", session_id: sessionId, is_error: false, subtype: "success" });
    } };
  }, config);
  t.after(() => service.close());
  const chat = (await service.command({ type: "create", taskId: f.taskId, cwd: f.dir, name: "Router fixture" })).chat!;
  await service.command({ type: "send", chatId: chat.chatId, sendId: randomUUID(), text: "Synthetic" });
  await until(async () => !(await service.command({ type: "read", chatId: chat.chatId })).chat!.active);
  assert.equal(options?.model, "deepseek/deepseek-v4.1-flash-1017");
  assert.equal(options?.env?.ANTHROPIC_API_KEY, "");
  assert.equal(options?.env?.ANTHROPIC_AUTH_TOKEN, credential);
  assert.equal(options?.env?.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
  assert.equal(options?.env?.HTTPS_PROXY, "http://proxy.invalid:8080");
  assert.equal(options?.env?.NODE_USE_ENV_PROXY, "1");
  assert.equal(options?.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  for (const key of ["ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) assert.equal(options?.env?.[key], options?.model);
  const reply = await service.command({ type: "read", chatId: chat.chatId });
  assert.equal(reply.provider, "openrouter");
  assert.ok(!JSON.stringify(reply).includes(credential));
  assert.ok(!JSON.stringify(f.store.db.prepare("SELECT * FROM embedded_sessions").all()).includes(credential));
  assert.ok(!JSON.stringify(f.store.db.prepare("SELECT * FROM embedded_events").all()).includes(credential));
});

test("provider/model switches and legacy sessions require a fresh chat and retain history", async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return { close() {}, async *[Symbol.asyncIterator]() { yield sdk({ type: "result", session_id: sessionId, is_error: false, subtype: "success" }); } }; });
  const chat = await f.create();
  await f.service.command({ type: "send", chatId: chat.chatId, sendId: randomUUID(), text: "Keep this history" });
  await until(async () => !(await f.read(chat.chatId)).active);
  f.service.close();
  for (const config of [embeddedConfig({ ACD_EMBEDDED_PROVIDER: "openrouter", ANTHROPIC_AUTH_TOKEN: "synthetic" }), embeddedConfig({ ACD_EMBEDDED_AUTH: "api-key", ANTHROPIC_API_KEY: "synthetic", ACD_EMBEDDED_MODEL: "other-model" }), embeddedConfig({ ACD_EMBEDDED_AUTH: "api-key", ANTHROPIC_API_KEY: "synthetic", ACD_EMBEDDED_HELPER_MODEL: "other-helper" })]) {
    const service = new EmbeddedChats(f.store, f.dir, () => {}, true, async () => { calls++; throw new Error("must not run"); }, config);
    await assert.rejects(service.command({ type: "send", chatId: chat.chatId, sendId: randomUUID(), text: "Continue" }), /new embedded chat/);
    assert.equal((await service.command({ type: "read", chatId: chat.chatId })).chat!.sessionId, sessionId);
    service.close();
  }
  f.store.db.prepare("UPDATE embedded_sessions SET configIdentity=NULL WHERE chatId=?").run(chat.chatId);
  f.reopen();
  await assert.rejects(f.service.command({ type: "send", chatId: chat.chatId, sendId: randomUUID(), text: "Legacy" }), /legacy session/);
  assert.equal((await f.read(chat.chatId)).events[0].text, "Keep this history");
  assert.equal(calls, 1);
});

test("v15 migration backs up sessions and preserves task history without guessing model identity", async t => {
  const f = fixture(t, async () => { throw new Error("must not run"); });
  const chat = await f.create();
  f.store.db.prepare("UPDATE embedded_sessions SET sessionId=? WHERE chatId=?").run(sessionId, chat.chatId);
  f.store.db.exec("ALTER TABLE embedded_sessions DROP COLUMN configIdentity; ALTER TABLE embedded_sessions DROP COLUMN model; ALTER TABLE embedded_sessions DROP COLUMN provider; PRAGMA user_version=15;");
  f.reopen();
  assert.equal(f.store.db.pragma("user_version", { simple: true }), 16);
  assert.ok(readdirSync(f.dir).some(name => /^workspace\.sqlite\.bak-/.test(name)));
  assert.equal((await f.read(chat.chatId)).sessionId, sessionId);
  assert.ok(new PlanningStore(f.store).items()[0].chatIds.includes(chat.chatId));
  await assert.rejects(f.service.command({ type: "send", chatId: chat.chatId, sendId: randomUUID(), text: "Legacy" }), /new embedded chat/);
});

test("SDK result and assistant auth failures show safe diagnostics rather than provider payloads", async t => {
  const f = fixture(t, async () => ({ close() {}, async *[Symbol.asyncIterator]() {
    yield sdk({ type: "assistant", error: "authentication_failed", uuid: "auth", message: { id: "auth", content: [{ type: "text", text: "sensitive provider payload" }] } });
    yield sdk({ type: "result", is_error: true, subtype: "error_during_execution", errors: ["401 sensitive provider payload"] });
  } }));
  const chat = await f.create();
  await f.service.command({ type: "send", chatId: chat.chatId, sendId: randomUUID(), text: "Synthetic" });
  await until(async () => !(await f.read(chat.chatId)).active);
  const result = await f.read(chat.chatId);
  assert.equal(result.state, "error");
  assert.equal(result.events.filter(e => e.kind === "error" && /authentication rejected/.test(e.text)).length, 2);
  assert.ok(!JSON.stringify(result).includes("sensitive provider payload"));
});
