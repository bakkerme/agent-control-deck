import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Store } from "../src/main/store";
import { PlanningStore } from "../src/main/planning-store";
import type { LocalClient } from "../src/main/local-matcher";
import { MatchingAnalytics } from "../src/main/matching-analytics";
import { ChatMatcher } from "../src/main/chat-matcher";
import { SecretStore, type SecretEncryption } from "../src/main/secret-store";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, parseOutput, type MatchPayload, type requestMatch } from "../src/shared/chat-matching";
import { localPlanDay, nextPlanDay } from "../src/shared/planning";
import { matchingConfigSchema, saveMatchingSchema } from "../src/shared/matching-settings";
import { removeFixture } from "./fixture-cleanup";

// Test encryption is independent of OS credentials; the desktop test exercises safeStorage.
function encryption(): SecretEncryption {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt: async value => {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt: async value => {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12), { authTagLength: 16 });
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}
type Reply = Awaited<ReturnType<typeof requestMatch>>;
function reply(payload: MatchPayload, target: string | null): Reply {
  return {
    output: parseOutput(JSON.stringify({
      task_likelihoods: payload.tasks.map(task => ({ task_id: task.id, likelihood: target ? (task.id === target ? 0.99 : 0) : 0 })),
      no_match_likelihood: target ? 0.01 : 1, insufficient_context: false, reason: "Synthetic matching result",
    }), payload),
    metadata: { model: DEFAULT_MODEL, provider: "Amazon Bedrock", latency_ms: 1, prompt_tokens: 100, completion_tokens: 40, cost_usd: 0.00001 },
  };
}
const config = matchingConfigSchema.parse({ enabled: true, model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER });
const localConfig = matchingConfigSchema.parse({ ...config, backend: "local" });
function localFixtureClient() {
  let calls = 0, stops = 0;
  const client: LocalClient = {
    status: () => ({state:"installed",progress:"",error:null,startupMs:null}),
    install: async ()=>{}, stop: ()=>{stops++;},
    request: async payload => {
      calls++;
      const target=payload.tasks.find(t=>t.title==="Payments")!.id;
      const output=reply(payload,target).output;
      output.task_likelihoods=output.task_likelihoods.map(t=>({...t,likelihood:t.task_id===target?.7:0}));
      output.no_match_likelihood=.3;
      return {output,contextScore:.5,inferenceMs:100,cpuMs:250,peakRssBytes:123456,cold:calls===1};
    },
  };
  return {client,get calls(){return calls;},get stops(){return stops;}};
}
function fixture(t: { after: (fn: () => void) => void }, local?: LocalClient) {
  const dir = mkdtempSync(join(tmpdir(), "acd-matching-")), file = join(dir, "workspace.sqlite"), cipherFile = join(dir, "openrouter-key.enc");
  let store = new Store(file), time = Date.now(), sequence = 0;
  const secrets = new SecretStore(cipherFile, encryption()), bedrockSecrets = new SecretStore(join(dir, "bedrock-key.enc"), encryption()), calls: MatchPayload[] = [];
  const keyStores = { openrouter: secrets, bedrock: bedrockSecrets };
  let client: typeof requestMatch = async payload => { calls.push(payload); return reply(payload, payload.tasks.find(task => task.title === "Payments")?.id ?? null); };
  let matcher = new ChatMatcher(store, keyStores, () => {}, false, (payload, options) => client(payload, options), () => time, local);
  store.command({ type: "createSource", name: "Claude", provider: "claude", environment: "native" });
  const sourceId = store.sources()[0].id;
  store.command({ type: "importDailyPlan", card: `date: ${localPlanDay()}\ncoding:\n  - name: Portal\n    tickets: [PORT-87]\n  - name: Payments\n    tickets: [PAY-142]\n`, sourceName: "fixture", itemIds: [null, null] });
  const emit = (prompt: string, session = "chat") => {
    store.ingest(sourceId, { version: 1, eventId: `event-${++sequence}`, observedAt: new Date(time).toISOString(),
      payload: { hook_event_name: "UserPromptSubmit", session_id: session, cwd: "/fixture/customer-portal", prompt } });
    return store.chats().find(chat => chat.externalId === session)!.id;
  };
  const chatId = emit("Investigate PAY-142 webhook retries");
  const itemId = new PlanningStore(store).items().find(item => item.name === "Payments")!.id;
  const portalId = new PlanningStore(store).items().find(item => item.name === "Portal")!.id;
  t.after(() => { matcher.dispose(); store.close(); removeFixture(dir); });
  return {
    dir, file, cipherFile, secrets, bedrockSecrets, calls, chatId, itemId, portalId, emit,
    get store() { return store; }, get matcher() { return matcher; },
    get plans() { return new PlanningStore(store); },
    advance(ms = 12_000) { time += ms; },
    useClient(next: typeof requestMatch) { client = next; },
    async enable() { await matcher.save(config, "synthetic-api-key"); },
    reopen(demo = false) {
      matcher.dispose(); store.close(); store = new Store(file);
      matcher = new ChatMatcher(store, keyStores, () => {}, demo, (payload, options) => client(payload, options), () => time, local);
    },
  };
}

test("credentials are ciphertext, replacement is atomic, removal works, and failures retain the old key", async t => {
  const f = fixture(t);
  await f.secrets.save("first-private-key");
  assert.equal(await f.secrets.read(), "first-private-key");
  assert.equal(readFileSync(f.cipherFile).includes(Buffer.from("first-private-key")), false);
  if (process.platform !== "win32") assert.equal(statSync(f.cipherFile).mode & 0o777, 0o600);
  const unavailable = new SecretStore(f.cipherFile, { available: () => false, encrypt: () => { throw new Error("must not encrypt"); }, decrypt: () => "" });
  await assert.rejects(unavailable.save("replacement"), /unavailable/);
  const broken = new SecretStore(f.cipherFile, { available: () => true, encrypt: () => { throw new Error("private-key-must-not-leak"); }, decrypt: () => "" });
  await assert.rejects(broken.save("replacement"), /previous saved key was kept/);
  assert.equal(await f.secrets.read(), "first-private-key");
  await f.secrets.save("replacement"); assert.equal(await f.secrets.read(), "replacement");
  f.secrets.remove(); assert.equal(f.secrets.hasKey(), false);
});
test("corrupt and oversized ciphertext returns a generic repair error", async t => {
  const f = fixture(t);
  writeFileSync(f.cipherFile, "corrupt-private-text");
  await assert.rejects(f.secrets.read(), /Could not unlock/);
  writeFileSync(f.cipherFile, Buffer.alloc(131073));
  await assert.rejects(f.secrets.read(), /Could not unlock/);
});
test("matching is off by default and keys are absent from SQLite and status", async t => {
  const f = fixture(t);
  await f.matcher.tick(); assert.equal(f.calls.length, 0);
  await f.enable();
  assert.equal(JSON.stringify(f.matcher.status()).includes("synthetic-api-key"), false);
  assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM settings").all()).includes("synthetic-api-key"), false);
  assert.equal(readFileSync(f.cipherFile).includes(Buffer.from("synthetic-api-key")), false);
  await f.matcher.removeKey();
  assert.equal(f.matcher.status().config.enabled, false); assert.equal(f.matcher.status().keyStored, false);
});

test("local links need no key, use calibrated Kai policy, coalesce evidence and cache across restart", async t=>{
  const local=localFixtureClient(),f=fixture(t,local.client);
  await f.matcher.save(localConfig);
  assert.equal(f.secrets.hasKey(),false);
  await f.matcher.tick(); assert.equal(local.calls,0);
  f.emit("Updated PAY-142 request"); f.advance(500);await f.matcher.tick();assert.equal(local.calls,0);
  f.advance(1000);await f.matcher.tick(); assert.equal(local.calls,1);
  assert.deepEqual(f.plans.items().find(i=>i.id===f.itemId)!.automaticChatIds,[f.chatId]);
  const analytics=new MatchingAnalytics(f.store).summary();
  assert.equal(analytics.outcomes.linked,1);assert.equal(analytics.configurations[0].policy.likelihood,.5);
  assert.equal(analytics.configurations[0].warmSamples,0);
  const stops=local.stops;await f.matcher.save(localConfig);assert.equal(local.stops,stops);
  f.reopen();await f.matcher.tick();assert.equal(local.calls,1);
});

test("local freshness rejection records a stale result without linking and leaves ingestion usable", async t=>{
  const local=localFixtureClient(),f=fixture(t,local.client),original=local.client.request;
  local.client.request=async(...args)=>{const result=await original(...args);f.emit("A different PAY-142 request");return result;};
  await f.matcher.save(localConfig);await f.matcher.tick();f.advance(1000);await f.matcher.tick();
  assert.equal(f.plans.items().some(i=>i.chatIds.includes(f.chatId)),false);
  assert.equal(new MatchingAnalytics(f.store).summary().outcomes.stale,1);
  assert.equal(f.matcher.status().error,null);
});

test("analytics distinguish remove and Undo; clearing preserves links and the matcher cache", async t=>{
  const local=localFixtureClient(),f=fixture(t,local.client);
  await f.matcher.save(localConfig);await f.matcher.tick();f.advance(1000);await f.matcher.tick();
  f.store.command({type:"setPlanChats",id:f.itemId,chatIds:[]});
  f.store.command({type:"undoPlanning",undoId:f.plans.undoId()!});
  const analytics=new MatchingAnalytics(f.store),summary=analytics.summary();
  assert.equal(summary.feedback.removed,1);assert.equal(summary.feedback.undoRestored,1);
  assert.equal(summary.quality.precision,null);
  const exported=analytics.export();
  assert.ok(!exported.includes(f.chatId));assert.ok(!exported.includes(f.itemId));assert.ok(!exported.includes("PAY-142"));assert.ok(!exported.includes("Payments"));
  analytics.clear();assert.equal(analytics.summary().assessments,0);
  assert.deepEqual(f.plans.items().find(i=>i.id===f.itemId)!.automaticChatIds,[f.chatId]);
  assert.ok(f.store.db.prepare("SELECT * FROM ai_match_attempts WHERE chatId=?").get(f.chatId));
});

test("v12 analytics migration preserves links, dismissals and cache and makes a backup",async t=>{
  const f=fixture(t);await f.enable();await f.matcher.tick();
  f.store.db.exec("DROP TABLE matching_measurements; DROP TABLE matching_feedback; PRAGMA user_version=12;");
  f.reopen();
  assert.equal(f.store.db.pragma("user_version",{simple:true}),13);
  assert.deepEqual(f.plans.items().find(i=>i.id===f.itemId)!.automaticChatIds,[f.chatId]);
  assert.ok(f.store.db.prepare("SELECT * FROM ai_match_attempts WHERE chatId=?").get(f.chatId));
  assert.ok(readdirSync(f.dir).some(name=>name.startsWith("workspace.sqlite.bak-")));
});
test("key and routing inputs validate at the boundary", async t => {
  const f = fixture(t);
  assert.throws(() => saveMatchingSchema.parse({ config, apiKey: "key\nheader" }));
  assert.throws(() => saveMatchingSchema.parse({ config: { ...config, provider: "https://evil.example" } }));
  assert.throws(() => saveMatchingSchema.parse({ config, apiKey: "key", path: "/private/file" }));
  await assert.rejects(f.matcher.save(config), /Save an API key/);
});
test("Bedrock keeps its own encrypted token, preserves OpenRouter credentials, and resumes after restart", async t => {
  const f = fixture(t), bedrock = { ...config, backend: "bedrock" as const };
  await f.enable();
  await assert.rejects(f.matcher.save(bedrock), /Save an API key/);
  const token = `bedrock-synthetic-${"x".repeat(2500)}`;
  await f.matcher.save(bedrock, token);
  assert.equal(await f.secrets.read(), "synthetic-api-key");
  assert.equal(await f.bedrockSecrets.read(), token);
  assert.equal(JSON.stringify(f.matcher.status()).includes(token), false);
  assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM settings").all()).includes(token), false);
  f.reopen();
  f.useClient(async (payload, options) => {
    assert.equal(options?.backend, "bedrock"); assert.equal(options?.region, "ap-southeast-2");
    assert.equal(options?.model, "global.openai.gpt-6-luna"); assert.equal(options?.apiKey, token);
    return reply(payload, f.itemId);
  });
  await f.matcher.tick();
  assert.deepEqual(f.plans.items().find(item => item.id === f.itemId)!.automaticChatIds, [f.chatId]);
  await f.matcher.removeKey();
  assert.equal(f.bedrockSecrets.hasKey(), false); assert.equal(f.secrets.hasKey(), true);
});
test("old OpenRouter settings retain their service and model when new Bedrock fields default", async t => {
  const f = fixture(t);
  f.store.db.prepare("INSERT INTO settings (key,value) VALUES ('chatMatching',?)").run(JSON.stringify({ enabled: false, model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER }));
  f.reopen();
  assert.equal(f.matcher.status().config.backend, "openrouter");
  assert.equal(f.matcher.status().config.model, DEFAULT_MODEL);
  assert.throws(() => saveMatchingSchema.parse({ config: { ...config, backend: "bedrock", bedrockRegion: "us-east-1.evil.example" } }));
  assert.throws(() => saveMatchingSchema.parse({ config: { ...config, bedrockModel: "https://evil.example" } }));
});
test("clear matches add durable AI provenance without changing lifecycle or done state", async t => {
  const f = fixture(t), oldChat = f.store.chat(f.chatId);
  await f.enable(); await f.matcher.tick();
  assert.deepEqual(f.plans.items().find(item => item.id === f.itemId)!.automaticChatIds, [f.chatId]);
  assert.equal(f.store.chat(f.chatId).state, oldChat.state);
  assert.equal(f.plans.entries().every(entry => !entry.workedOn), true);
  f.reopen(); await f.matcher.tick();
  assert.deepEqual(f.plans.items().find(item => item.id === f.itemId)!.automaticChatIds, [f.chatId]);
  assert.equal(f.calls.length, 1);
});
test("manual links and archived chats prevent inference", async t => {
  const f = fixture(t); await f.enable();
  f.store.command({ type: "setPlanChats", id: f.portalId, chatIds: [f.chatId] });
  await f.matcher.tick(); assert.equal(f.calls.length, 0);
  const other = f.emit("PAY-142", "archived");
  f.store.command({ type: "updateChat", id: other, patch: { archived: true } });
  await f.matcher.tick(); assert.equal(f.calls.length, 0);
});
test("X records a durable pair dismissal; manual re-link clears it and Undo restores provenance", async t => {
  const f = fixture(t); await f.enable(); await f.matcher.tick();
  f.store.command({ type: "setPlanChats", id: f.itemId, chatIds: [] });
  const undoId = f.plans.undoId()!;
  assert.ok(f.store.db.prepare("SELECT 1 FROM ai_link_dismissals WHERE itemId=? AND chatId=?").get(f.itemId, f.chatId));
  f.store.command({ type: "undoPlanning", undoId });
  assert.deepEqual(f.plans.items().find(item => item.id === f.itemId)!.automaticChatIds, [f.chatId]);
  assert.equal((f.store.db.prepare("SELECT COUNT(*) AS n FROM ai_link_dismissals").get() as { n: number }).n, 0);
  f.store.command({ type: "setPlanChats", id: f.itemId, chatIds: [] });
  f.reopen(); f.advance(); await f.matcher.tick();
  assert.equal(f.calls.at(-1)!.tasks.some(task => task.id === f.itemId), false);
  assert.equal(f.plans.items().find(item => item.id === f.itemId)!.chatIds.length, 0);
  f.store.command({ type: "setPlanChats", id: f.itemId, chatIds: [f.chatId] });
  assert.equal(f.plans.items().find(item => item.id === f.itemId)!.automaticChatIds!.length, 0);
});
test("background matching preserves a user Undo and unrelated automatic links survive it", async t => {
  const f = fixture(t);
  f.store.command({ type: "updatePlanItem", id: f.portalId, patch: { notes: "User edit" } });
  const undoId = f.plans.undoId()!;
  await f.enable(); await f.matcher.tick();
  assert.equal(f.plans.undoId(), undoId);
  f.store.command({ type: "undoPlanning", undoId });
  assert.equal(f.plans.items().find(item => item.id === f.portalId)!.notes, "");
  assert.deepEqual(f.plans.items().find(item => item.id === f.itemId)!.automaticChatIds, [f.chatId]);
});
test("unchanged abstentions are cached across restart; new conversation evidence can be assessed", async t => {
  const f = fixture(t);
  f.useClient(async payload => { f.calls.push(payload); return reply(payload, null); });
  await f.enable(); await f.matcher.tick(); f.advance(); await f.matcher.tick();
  f.reopen(); f.advance(); await f.matcher.tick(); assert.equal(f.calls.length, 1);
  f.emit("Review a new topic under PAY-142"); f.advance(); await f.matcher.tick(); assert.equal(f.calls.length, 2);
});
test("parallel ticks serialize and enforce the twelve-second request interval", async t => {
  const f = fixture(t);
  f.emit("PAY-142", "second");
  f.useClient(async payload => { f.calls.push(payload); return reply(payload, null); });
  await f.enable(); await Promise.all([f.matcher.tick(), f.matcher.tick(), f.matcher.tick()]);
  assert.equal(f.calls.length, 1); await f.matcher.tick(); assert.equal(f.calls.length, 1);
  f.reopen(); await f.matcher.tick(); assert.equal(f.calls.length, 1);
  f.advance(11_999); await f.matcher.tick(); assert.equal(f.calls.length, 1);
  f.advance(1); await f.matcher.tick(); assert.equal(f.calls.length, 2);
});
for (const change of ["task-edit", "manual-link", "dismiss", "disable", "service-switch", "workspace-switch"] as const) {
  test(`in-flight ${change} prevents a stale response from changing links`, async t => {
    const f = fixture(t);
    let finish!: (result: Reply) => void, captured!: MatchPayload, signal: AbortSignal | undefined;
    const pending = new Promise<Reply>(resolve => finish = resolve);
    f.useClient(async (payload, options) => { captured = payload; signal = options?.signal; return pending; });
    await f.enable(); const operation = f.matcher.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(captured);
    if (change === "task-edit") f.store.command({ type: "updatePlanItem", id: f.itemId, patch: { notes: "Changed while matching" } });
    if (change === "manual-link") f.store.command({ type: "setPlanChats", id: f.portalId, chatIds: [f.chatId] });
    if (change === "dismiss") {
      f.store.command({ type: "setPlanChats", id: f.itemId, chatIds: [f.chatId] });
      f.store.command({ type: "setPlanChats", id: f.itemId, chatIds: [] });
    }
    if (change === "disable") { await f.matcher.save({ ...config, enabled: false }); assert.equal(signal?.aborted, true); }
    if (change === "service-switch") { await f.matcher.save({ ...config, backend: "bedrock" }, "synthetic-bedrock"); assert.equal(signal?.aborted, true); }
    if (change === "workspace-switch") { f.reopen(true); assert.equal(signal?.aborted, true); }
    finish(reply(captured, f.itemId)); await operation;
    assert.equal(f.plans.items().some(item => item.automaticChatIds?.includes(f.chatId)), false);
  });
}
test("provider failure pauses matching while new hook events still ingest", async t => {
  const f = fixture(t);
  f.useClient(async () => { throw new Error("OpenRouter HTTP 401 (no retry)"); });
  await f.enable(); await f.matcher.tick();
  assert.match(f.matcher.status().error!, /401/);
  const accepted = f.store.sources()[0].accepted;
  f.emit("A new observed prompt"); assert.equal(f.store.sources()[0].accepted, accepted + 1);
  f.advance(); await f.matcher.tick(); assert.equal(f.calls.length, 0);
  f.useClient(async payload => { f.calls.push(payload); return reply(payload, f.itemId); });
  await f.matcher.save(config); await f.matcher.tick(); assert.equal(f.calls.length, 1);
});
test("demo never sends automatic requests; the connection test sends only its synthetic payload", async t => {
  const f = fixture(t); await f.enable(); f.reopen(true);
  f.useClient(async (payload, options) => {
    assert.equal(options?.syntheticDiagnostics, true);
    f.calls.push(payload); return reply(payload, null);
  });
  await f.matcher.tick(); assert.equal(f.calls.length, 0);
  await f.matcher.testConnection();
  assert.equal(f.calls[0].chat.id, "connection-test");
  assert.equal(f.calls[0].tasks.length, 1);
  assert.equal(f.plans.items().every(item => !item.chatIds.length), true);
});
test("automatic requests never opt into provider error message diagnostics", async t => {
  const f = fixture(t); await f.enable();
  f.useClient(async (payload, options) => {
    assert.equal(options?.syntheticDiagnostics, undefined);
    f.calls.push(payload); return reply(payload, null);
  });
  await f.matcher.tick(); assert.equal(f.calls.length, 1);
});
test("only today's observed chats and tasks are eligible", async t => {
  const f = fixture(t); await f.enable();
  f.store.command({ type: "reschedulePlanItem", id: f.itemId, fromDay: localPlanDay(), day: nextPlanDay(localPlanDay()), category: "Coding" });
  f.useClient(async payload => { f.calls.push(payload); return reply(payload, null); });
  await f.matcher.tick(); assert.equal(f.calls[0].tasks.some(task => task.id === f.itemId), false);
  f.advance(2 * 24 * 60 * 60 * 1000); await f.matcher.tick(); assert.equal(f.calls.length, 1);
});
test("v11 migration keeps manual associations and makes one recoverable backup", t => {
  const f = fixture(t);
  f.store.command({ type: "setPlanChats", id: f.itemId, chatIds: [f.chatId] });
  f.store.db.exec("DROP TABLE matching_measurements; DROP TABLE matching_feedback; DROP TABLE ai_link_dismissals; DROP TABLE ai_match_attempts; ALTER TABLE plan_chats DROP COLUMN origin; PRAGMA user_version=11;");
  f.reopen();
  const item = f.plans.items().find(item => item.id === f.itemId)!;
  assert.deepEqual(item.chatIds, [f.chatId]); assert.deepEqual(item.automaticChatIds, []);
  const backups = readdirSync(f.dir).filter(name => name.includes(".bak-")); assert.equal(backups.length, 1);
  f.reopen(); assert.equal(readdirSync(f.dir).filter(name => name.includes(".bak-")).length, 1);
});
