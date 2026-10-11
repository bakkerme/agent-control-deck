import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { InteractionQueue } from "../src/main/interactions";
import { HookReceiver } from "../src/main/http";
import { Store } from "../src/main/store";
import { Inbox } from "../src/main/inbox";
import { sourceToken, sourceSetup } from "../src/main/setup";
import type { Source } from "../src/shared/types";

const source = { id: "test-source", name: "Claude", provider: "claude", responsesEnabled: true } as Source;
const permission = { hook_event_name: "PermissionRequest", session_id: "session", tool_use_id: "tool", tool_name: "Bash", tool_input: { command: "git status", description: "Inspect changes" } };
const question = { ...permission, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: {
  questions: [{ header: "Route", question: "Which route?", multiSelect: true, options: [{ label: "Dock", description: "Use the dock" }, { label: "Spotlight", description: "Use the modal" }] }],
  metadata: { keep: true },
} };

test("decisions bind to a specific live request; retries acknowledge once and never authorize a later call", async () => {
  const queue = new InteractionQueue(() => {});
  let output = "", sends = 0;
  const id = queue.add(source, permission, async value => { sends++; output = value; }, () => {});
  const response = { id, kind: "permission", decision: "allow" };
  await assert.rejects(queue.answer({ ...response, command: "anything else" }));
  await assert.rejects(queue.answer({ id, kind: "question", answers: ["yes"] }));
  assert.throws(() => queue.add(source, permission, async () => {}, () => {}), /already waiting/);
  await queue.answer(response);
  assert.deepEqual(JSON.parse(output), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  await queue.answer(response);
  assert.equal(sends, 1);
  await assert.rejects(queue.answer({ ...response, decision: "deny" }), /no longer waiting/);
  const later = queue.add(source, permission, async () => {}, () => {});
  assert.notEqual(later, id);
  await queue.answer(response);
  assert.equal(queue.snapshot()[0].id, later);
  queue.clear();
});

test("Claude answers preserve tool input, validate choices and support multiple or custom answers", async () => {
  const queue = new InteractionQueue(() => {});
  let output = "";
  const id = queue.add(source, question, async value => { output = value; }, () => {});
  await assert.rejects(queue.answer({ id, kind: "question", answers: [["Unknown"]] }), /valid options/);
  await assert.rejects(queue.answer({ id, kind: "question", answers: [["Dock", "Dock"]] }), /valid options/);
  await queue.answer({ id, kind: "question", answers: [["Dock", "Spotlight"]] });
  assert.deepEqual(JSON.parse(output).hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...question.tool_input, answers: { "Which route?": "Dock, Spotlight" } } });
  const custom = queue.add(source, question, async value => { output = value; }, () => {});
  await queue.answer({ id: custom, kind: "question", answers: ["  My own route  "] });
  assert.equal(JSON.parse(output).hookSpecificOutput.updatedInput.answers["Which route?"], "My own route");
  assert.throws(() => queue.add({ ...source, provider: "codex" }, question, async () => {}, () => {}), /Unsupported/);
});

test("delivery failure retains the request; deadlines, disconnects and source/session cancellation cannot grant permission", async () => {
  const queue = new InteractionQueue(() => {}, 100);
  let attempts = 0, expired = 0;
  const id = queue.add(source, permission, async () => { if (++attempts === 1) throw new Error("Transport failed"); }, () => expired++);
  await assert.rejects(queue.answer({ id, kind: "permission", decision: "deny" }), /Transport failed/);
  assert.equal(queue.snapshot().length, 1);
  await queue.answer({ id, kind: "permission", decision: "deny" });
  assert.equal(expired, 0);
  const pending = queue.add(source, permission, async () => assert.fail("Must not send"), () => expired++);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(expired, 1);
  await assert.rejects(queue.answer({ id: pending, kind: "permission", decision: "allow" }), /no longer waiting/);
  const detached = queue.add(source, permission, async () => assert.fail(), () => expired++);
  queue.detach(detached);
  assert.equal(expired, 1);
  queue.add(source, permission, async () => assert.fail(), () => expired++);
  queue.cancelSession("other-source", "session");
  assert.equal(queue.snapshot().length, 1);
  queue.cancelSession(source.id, "session");
  assert.equal(expired, 2);
  queue.add(source, permission, async () => assert.fail(), () => expired++);
  queue.cancelSource(source.id);
  assert.equal(expired, 3);
});

test("request capacity is bounded and clearing the queue returns every hook without a decision", () => {
  const queue = new InteractionQueue(() => {});
  let expired = 0;
  for (let i = 0; i < 8; i++) queue.add(source,{ ...permission,tool_use_id:String(i) },async () => assert.fail(),() => expired++);
  assert.throws(() => queue.add(source,{ ...permission,tool_use_id:"overflow" },async () => assert.fail(),() => expired++),/full/);
  assert.equal(queue.snapshot().length,8);
  queue.clear();
  assert.equal(expired,8);
  assert.equal(queue.snapshot().length,0);
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), "acd-responses-"));
  const store = new Store(join(root, "workspace.sqlite"));
  for (const provider of ["claude", "codex", "cursor"] as const)
    store.command({ type: "createSource", provider, name: provider, environment: "native" });
  const queue = new InteractionQueue(() => {});
  const inbox = new Inbox(store, root, () => {});
  const receiver = new HookReceiver(() => ({ store, root, inbox, demo: false, interactions: queue }));
  const connection = await receiver.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { if (receiver.server.listening) await receiver.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const send = (provider: string, payload: typeof permission | typeof question = permission, headers: Record<string,string> = {}, signal?: AbortSignal) => {
    const s = store.sources().find(s => s.provider === provider)!;
    return fetch(`${connection.url}/requests/${s.id}/${payload.hook_event_name}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sourceToken(root,s.id)}`, ...headers }, body: JSON.stringify(payload), signal });
  };
  const enable = (provider: string) => store.command({ type: "setSourceResponses", id: store.sources().find(s => s.provider === provider)!.id, enabled: true });
  return { root, store, queue, inbox, receiver, connection, send, enable };
}
async function waiting(queue: InteractionQueue, count = 1) {
  for (let i = 0; i < 100 && queue.snapshot().length !== count; i++) await new Promise(resolve => setTimeout(resolve,10));
  assert.equal(queue.snapshot().length, count);
  return queue.snapshot();
}

test("response receiver requires opt-in and source authentication; holds a live hook beyond upload timeout", async t => {
  const f = await fixture(t);
  assert.equal((await f.send("claude")).status, 404);
  f.enable("claude");
  assert.equal((await f.send("claude",permission,{ Authorization: "" })).status, 401);
  assert.equal((await f.send("claude",permission,{ Origin: "https://example.com" })).status, 403);
  const codex = f.store.sources().find(s => s.provider === "codex")!;
  assert.equal((await f.send("claude",permission,{ Authorization: `Bearer ${sourceToken(f.root,codex.id)}` })).status, 401);
  assert.throws(() => f.enable("cursor"), /available/);
  const result = f.send("claude");
  const [request] = await waiting(f.queue);
  await new Promise(resolve => setTimeout(resolve, 3200));
  await f.queue.answer({ id: request.id, kind: "permission", decision: "deny" });
  assert.equal(JSON.parse(await (await result).text()).hookSpecificOutput.decision.behavior, "deny");
  assert.equal(f.store.chats().length, 0); // Requests neither discover chats nor rewrite observations.
  const abort = new AbortController();
  const disconnected = f.send("claude",permission,{},abort.signal).catch(() => {});
  await waiting(f.queue);
  abort.abort(); await disconnected;
  await waiting(f.queue,0);
  const unsupported = await f.send("claude",{ ...permission, hook_event_name: "PreToolUse", tool_name: "Bash" });
  assert.equal(await unsupported.text(), "");
});

test("generated Codex command returns the exact decision on stdout; closed deck yields no decision", async t => {
  const f = await fixture(t);
  f.enable("codex");
  const s = f.store.sources().find(s => s.provider === "codex")!;
  const setup = sourceSetup(f.root,s,process.platform,f.connection);
  const config = JSON.parse(setup.config);
  assert.equal(config.hooks.PreToolUse, undefined);
  const run = () => new Promise<{ code: number | null; output: string }>((resolve,reject) => {
    const child = spawn(config.hooks.PermissionRequest[0].hooks[0].command,{ shell: true });
    let output = "";
    child.stdout.on("data",data => output += data);
    child.on("error",reject); child.on("close",code => resolve({ code, output }));
    child.stdin.end(JSON.stringify(permission));
  });
  const result = run();
  const [pending] = await waiting(f.queue);
  await f.queue.answer({ id: pending.id, kind: "permission", decision: "allow" });
  assert.deepEqual(await result,{ code: 0, output: JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }) });
  await f.receiver.close();
  assert.deepEqual(await run(),{ code: 0, output: "" });
});

test("an authenticated terminal event cancels matching requests even when the observation inbox fails", async t => {
  const f = await fixture(t);
  f.enable("claude");
  const result = f.send("claude");
  await waiting(f.queue);
  f.inbox.enqueue = () => { throw new Error("Disk unavailable"); };
  const s = f.store.sources().find(s => s.provider === "claude")!;
  const ended = await fetch(`${f.connection.url}/hooks/${s.id}/SessionEnd`,{ method:"POST",headers:{ Authorization:`Bearer ${sourceToken(f.root,s.id)}`,"Content-Type":"application/json" },body:JSON.stringify({ hook_event_name:"SessionEnd",session_id:"session",reason:"other" }) });
  assert.equal(ended.status,503);
  assert.equal(await (await result).text(),"");
  assert.equal(f.queue.snapshot().length,0);
});

test("source response preference is disabled by default and survives reopening the database", () => {
  const root = mkdtempSync(join(tmpdir(), "acd-response-settings-"));
  let store = new Store(join(root, "workspace.sqlite"));
  try {
    store.command({ type: "createSource", provider: "claude", name: "Claude", environment: "native" });
    const id = store.sources()[0].id;
    assert.equal(store.source(id).responsesEnabled,false);
    store.command({ type: "setSourceResponses", id, enabled: true });
    store.close(); store = new Store(join(root, "workspace.sqlite"));
    assert.equal(store.source(id).responsesEnabled,true);
    const native = JSON.parse(sourceSetup(root,store.source(id)).config);
    assert.equal(native.hooks.PreToolUse[0].matcher,"^AskUserQuestion$");
    assert.equal(native.hooks.PermissionRequest[0].hooks[0].type,"http");
    const wsl = JSON.parse(sourceSetup(root,{ ...store.source(id), environment: "wsl" },"win32").config);
    assert.match(wsl.hooks.PermissionRequest[0].hooks[0].command,/"\/mnt\/c\/Windows\/System32\/curl.exe"/);
    assert.match(wsl.hooks.PermissionRequest[0].hooks[0].command,/--max-time 305/);
    store.command({ type: "setSourceResponses", id, enabled: false });
    assert.equal(JSON.parse(sourceSetup(root,store.source(id)).config).hooks.PermissionRequest,undefined);
  } finally { store.close(); rmSync(root,{ recursive:true, force:true }); }
});
