import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentQuery, AgentRunner } from "../src/main/embedded-sdk";
import { ControlledQuery, deferred, faultFixture, sdk, success } from "./embedded-fault-harness";
import { Store } from "../src/main/store";
import { EmbeddedChats } from "../src/main/embedded-chat";
import { embeddedConfig } from "../src/main/embedded-config";

const limits = { timeout: 5000 };
function ask(options: Options, tool = "Write", input: Record<string, unknown> = { file_path: "effects.txt", content: "synthetic" }) {
  // Reusing SDK IDs across turns is intentional: Deck must bind its own request.
  return options.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: "same-tool", requestId: "same-sdk-request" });
}

test("startup cancellation releases ownership and closes a late query without mutating replacement", limits, async t => {
  const startup = deferred<AgentQuery>(), entered = deferred(), late = new ControlledQuery(), current = new ControlledQuery();
  let calls = 0;
  const f = faultFixture(t, async () => { if (++calls === 1) { entered.resolve(); return startup.promise; } return current; });
  const chat = await f.create();
  await f.send(chat.chatId); await entered.promise;
  await f.service.command({ type: "cancel", chatId: chat.chatId });
  // One event-loop barrier gives accepted cancellation its cleanup opportunity.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await f.read(chat.chatId)).active, false, "startup must not hold the chat or global slot after cancellation");
  await f.send(chat.chatId, "Replacement"); await current.parked();
  startup.resolve(late); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(late.closed, 1);
  assert.equal((await f.read(chat.chatId)).active, true);
  assert.equal((await f.read(chat.chatId)).state, "running");
  current.emit(success()); await f.wait(chat.chatId, c => !c.active);
});

test("decision storage failure keeps the permission recoverable and prevents effects", limits, async t => {
  const decision = deferred<PermissionResult | null>();
  const f = faultFixture(t, async (_text, options) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const result = await ask(options); decision.resolve(result);
    if (result?.behavior === "allow") f.commitEffect("allowed");
    yield success();
  } }));
  const chat = await f.create(); await f.send(chat.chatId);
  const request = (await f.wait(chat.chatId, c => c.requests.length === 1)).requests[0];
  f.store.db.exec("CREATE TEMP TRIGGER fail_decision BEFORE INSERT ON embedded_events WHEN NEW.text LIKE 'Allowed once:%' BEGIN SELECT RAISE(ABORT, 'synthetic decision disk failure'); END");
  await assert.rejects(f.service.command({ type: "decide", chatId: chat.chatId, requestId: request.id, allow: true }), /synthetic decision disk failure/);
  assert.deepEqual(f.effects(), []);
  assert.deepEqual((await f.read(chat.chatId)).requests.map(r => r.id), [request.id], "failed recording must not orphan the SDK waiter");
  f.store.db.exec("DROP TRIGGER fail_decision");
  await f.service.command({ type: "decide", chatId: chat.chatId, requestId: request.id, allow: false });
  assert.equal((await decision.promise)?.behavior, "deny");
  await f.wait(chat.chatId, c => !c.active); assert.deepEqual(f.effects(), []);
});

test("stale approval cannot apply to another chat, replacement run or restarted service", limits, async t => {
  const decisions: (PermissionResult | null)[] = [];
  const f = faultFixture(t, async (_text, options) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const result = await ask(options); decisions.push(result);
    if (result?.behavior === "allow") f.commitEffect("wrong approval");
    yield success();
  } }));
  const a = await f.create(), b = await f.create();
  await f.send(a.chatId);
  const old = (await f.wait(a.chatId, c => c.requests.length === 1)).requests[0];
  await f.send(b.chatId);
  const bRequest = (await f.wait(b.chatId, c => c.requests.length === 1)).requests[0];
  await assert.rejects(f.service.command({ type: "decide", chatId: b.chatId, requestId: old.id, allow: true }), /expired/);
  assert.equal((await f.read(b.chatId)).requests[0].id, bRequest.id);
  await f.service.command({ type: "cancel", chatId: a.chatId }); await f.wait(a.chatId, c => !c.active);
  await f.send(a.chatId, "Replacement");
  const replacement = (await f.wait(a.chatId, c => c.requests.length === 1)).requests[0];
  for (let i = 0; i < 2; i++) await assert.rejects(f.service.command({ type: "decide", chatId: a.chatId, requestId: old.id, allow: true }), /expired/);
  assert.equal((await f.read(a.chatId)).requests[0].id, replacement.id);
  await f.reopen(); await f.send(a.chatId, "After restart");
  const restored = (await f.wait(a.chatId, c => c.requests.length === 1)).requests[0];
  await assert.rejects(f.service.command({ type: "decide", chatId: a.chatId, requestId: replacement.id, allow: true }), /expired/);
  assert.equal((await f.read(a.chatId)).requests[0].id, restored.id);
  await f.service.command({ type: "decide", chatId: a.chatId, requestId: restored.id, allow: false });
  await f.wait(a.chatId, c => !c.active);
  assert.deepEqual(f.effects(), []); assert.ok(decisions.every(d => d?.behavior === "deny"));
});

test("multiple permission waiters resolve in reverse order once and cancellation denies the rest", limits, async t => {
  const resolved: string[] = [];
  const f = faultFixture(t, async (_text, options) => ({ close() {}, async *[Symbol.asyncIterator]() {
    await Promise.all(["first", "second", "third"].map(async name => {
      const result = await ask(options, "Write", { file_path: name });
      resolved.push(name);
      if (result?.behavior === "allow") f.commitEffect(name);
    }));
    yield success();
  } }));
  const chat = await f.create(); await f.send(chat.chatId);
  const pending = (await f.wait(chat.chatId, c => c.requests.length === 3)).requests;
  const decide = (index: number, allow: boolean) => f.service.command({ type: "decide", chatId: chat.chatId, requestId: pending[index].id, allow });
  await decide(2, true); await assert.rejects(decide(2, true), /expired/); await decide(1, false);
  assert.equal((await f.read(chat.chatId)).state, "waiting");
  await f.service.command({ type: "cancel", chatId: chat.chatId }); await f.wait(chat.chatId, c => !c.active);
  assert.deepEqual(resolved, ["third", "second", "first"]);
  assert.deepEqual(f.effects(), ["third"]);
});

test("effect committed before lost acknowledgement is retained without replay after reopen", limits, async t => {
  const committed = deferred(), acknowledgement = deferred(), parked = deferred();
  const resumes: (string | undefined)[] = []; let calls = 0;
  const runner: AgentRunner = async (_text, options) => {
    const turn = ++calls; resumes.push(options.resume);
    return { close() {}, async *[Symbol.asyncIterator]() {
      yield sdk({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" });
      if (turn === 1) {
        const result = await ask(options);
        if (result?.behavior === "allow") { f.commitEffect("committed"); committed.resolve(); }
        parked.resolve(); await acknowledgement.promise;
        yield sdk({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "lost", content: "late acknowledgement" }] } });
      }
      yield success();
    } };
  };
  const f = faultFixture(t, runner), chat = await f.create(), sendId = randomUUID();
  await f.send(chat.chatId, "Commit synthetic effect", sendId);
  const request = (await f.wait(chat.chatId, c => c.requests.length === 1)).requests[0];
  await f.service.command({ type: "decide", chatId: chat.chatId, requestId: request.id, allow: true });
  await committed.promise; await parked.promise;
  assert.deepEqual(f.effects(), ["committed"]);
  await f.service.command({ type: "cancel", chatId: chat.chatId }); await f.wait(chat.chatId, c => !c.active);
  assert.match((await f.read(chat.chatId)).events.at(-1)!.text, /side effects already completed/);
  await f.reopen(); await f.send(chat.chatId, "Commit synthetic effect", sendId);
  assert.equal(calls, 1, "same submission must never automatically replay an uncertain effect");
  await f.send(chat.chatId, "Inspect outcome only"); await f.wait(chat.chatId, c => !c.active);
  acknowledgement.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(resumes[1], "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(f.effects(), ["committed"]);
  assert.ok(!(await f.read(chat.chatId)).events.some(e => e.text.includes("late acknowledgement")));
});

test("simultaneous retries deduplicate before acknowledgement but new submissions stay distinct", limits, async t => {
  const queries: ControlledQuery[] = []; let calls = 0;
  const f = faultFixture(t, async () => { calls++; const q = new ControlledQuery(); queries.push(q); return q; });
  const chat = await f.create(), sendId = randomUUID();
  await Promise.all([f.send(chat.chatId, "Same words", sendId), f.send(chat.chatId, "Same words", sendId)]);
  assert.equal(calls, 1);
  await assert.rejects(f.send(chat.chatId, "Different words", sendId), /different message/);
  await assert.rejects(f.send(chat.chatId, "Same words"), /current turn/);
  queries[0].emit(success()); await f.wait(chat.chatId, c => !c.active);
  await f.send(chat.chatId, "Same words"); queries[1].emit(success()); await f.wait(chat.chatId, c => !c.active);
  assert.equal(calls, 2); assert.equal((await f.read(chat.chatId)).events.filter(e => e.kind === "user").length, 2);
});

test("send transaction failure rolls back acceptance and the same identifier remains usable", limits, async t => {
  let calls = 0;
  const f = faultFixture(t, async () => { calls++; return { close() {}, async *[Symbol.asyncIterator]() { yield success(); } }; });
  const chat = await f.create(), sendId = randomUUID();
  f.store.db.exec("CREATE TEMP TRIGGER fail_send BEFORE INSERT ON embedded_events WHEN NEW.kind='user' BEGIN SELECT RAISE(ABORT, 'synthetic send disk failure'); END");
  await assert.rejects(f.send(chat.chatId, "Synthetic", sendId), /synthetic send disk failure/);
  assert.equal(calls, 0); assert.equal((await f.read(chat.chatId)).active, false);
  assert.deepEqual(f.store.db.prepare("SELECT count(*) AS n FROM embedded_sends").get(), { n: 0 });
  assert.equal((await f.read(chat.chatId)).events.length, 0);
  f.store.db.exec("DROP TRIGGER fail_send");
  await f.send(chat.chatId, "Synthetic", sendId); await f.wait(chat.chatId, c => !c.active); assert.equal(calls, 1);
});

test("cancel before a delayed permission callback denies even with an independent SDK signal", limits, async t => {
  let options!: Options;
  const query = new ControlledQuery();
  const f = faultFixture(t, async (_text, opts) => { options = opts; return query; });
  const chat = await f.create(); await f.send(chat.chatId); await query.parked();
  await f.service.command({ type: "cancel", chatId: chat.chatId }); await f.wait(chat.chatId, c => !c.active);
  const result = await ask(options);
  if (result?.behavior === "allow") f.commitEffect("forbidden");
  assert.equal(result?.behavior, "deny"); assert.deepEqual(f.effects(), []);
});

test("EOF after an effect reports uncertainty and never automatically resubmits", limits, async t => {
  let calls = 0;
  const f = faultFixture(t, async () => { calls++; return { close() {}, async *[Symbol.asyncIterator]() { f.commitEffect("before EOF"); } }; });
  const chat = await f.create(); await f.send(chat.chatId); const result = await f.wait(chat.chatId, c => !c.active);
  assert.equal(result.state, "error"); assert.match(result.events.at(-1)!.text, /without a successful result/);
  assert.equal(calls, 1); assert.deepEqual(f.effects(), ["before EOF"]);
});

for (const stage of ["accepted", "session", "effect"]) test(`backend SIGKILL at ${stage} preserves durable prefix and never replays an accepted send`, limits, async t => {
  const dir = mkdtempSync(join(tmpdir(), "acd-embedded-crash-"));
  const child = fork(resolve("out-tests/embedded-crash-worker.cjs"), [dir, stage], {
    execPath: process.execPath, execArgv: [], env: { ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const checkpoint = deferred<{ chatId: string; sendId: string }>();
  let reached = false, output = "";
  child.stderr!.on("data", data => { output = (output + data).slice(-2000); });
  child.once("error", checkpoint.reject);
  child.once("message", message => { reached = true; checkpoint.resolve(message as { chatId: string; sendId: string }); });
  child.once("exit", () => { if (!reached) checkpoint.reject(new Error(`Crash worker exited before checkpoint: ${output}`)); });
  let store: Store | undefined, service: EmbeddedChats | undefined;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
    service?.close(); await new Promise<void>(resolve => setImmediate(resolve)); store?.close(); rmSync(dir, { recursive: true, force: true });
  });
  const { chatId, sendId } = await checkpoint.promise;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  store = new Store(join(dir, "workspace.sqlite"));
  assert.equal(store.db.pragma("integrity_check", { simple: true }), "ok");
  let calls = 0, resume: string | undefined;
  service = new EmbeddedChats(store, dir, () => {}, true, async (_prompt, options) => { calls++; resume = options.resume; return new ControlledQuery(); }, embeddedConfig({ ACD_EMBEDDED_AUTH: "api-key", ANTHROPIC_API_KEY: "synthetic-fault-key" }));
  const restored = (await service.command({ type: "read", chatId })).chat!;
  assert.equal(restored.active, false); assert.equal(restored.state, "idle"); assert.deepEqual(restored.requests, []);
  assert.equal(restored.events.filter(e => e.kind === "user").length, 1);
  assert.equal(restored.events[0].text, "Synthetic crash submission");
  assert.match(restored.events.at(-1)!.text, /interrupted/);
  assert.equal(restored.sessionId, stage === "accepted" ? null : "11111111-1111-4111-8111-111111111111");
  await service.command({ type: "send", chatId, sendId, text: "Synthetic crash submission" });
  assert.equal(calls, 0, "durable acceptance cannot be silently replayed, even before session ID capture");
  await service.command({ type: "send", chatId, sendId: randomUUID(), text: "Inspect synthetic recovery" });
  assert.equal(calls, 1); assert.equal(resume, restored.sessionId ?? undefined);
  const ledger = join(dir, "effects.txt");
  assert.equal(existsSync(ledger) ? readFileSync(ledger, "utf8") : "", stage === "effect" ? "committed\n" : "");
});
