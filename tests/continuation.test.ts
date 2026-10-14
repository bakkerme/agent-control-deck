import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { PlanningStore } from "../src/main/planning-store";
import { ChatMatcher } from "../src/main/chat-matcher";
import { SecretStore, type SecretEncryption } from "../src/main/secret-store";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, parseOutput, type MatchPayload, type requestMatch } from "../src/shared/chat-matching";
import { matchingConfigSchema } from "../src/shared/matching-settings";
import { quickContinuation } from "../src/shared/continuation";
import { removeFixture } from "./fixture-cleanup";

type Candidates = ReturnType<PlanningStore["continuationCandidates"]>;
const asTasks = (list: Candidates) => list.map(c => ({ id: c.id, title: c.title, notes: c.aliases.length ? `Also called: ${c.aliases.join("; ")}` : "", day_note: "", ticket_keys: c.ticket_keys }));

const candidates = [
  { id: "a", title: "Ship Billing Export", ticket_keys: ["EXP-1"] },
  { id: "b", title: "Review hooks", ticket_keys: ["HOOK-2", "EXP-9"] },
];

test("quick suggestions need an identical title or a ticket only one candidate carries", () => {
  assert.deepEqual(quickContinuation({ name: "  ship billing EXPORT! ", ticketKeys: [] }, candidates)?.itemId, "a");
  assert.equal(quickContinuation({ name: "Finalise Billing Export", ticketKeys: [] }, candidates), null);
  const byTicket = quickContinuation({ name: "Something else", ticketKeys: ["hook-2"] }, candidates);
  assert.deepEqual([byTicket?.itemId, byTicket?.source, byTicket?.strength], ["b", "ticket", "suggested"]);
  assert.equal(quickContinuation({ name: "x", ticketKeys: ["EXP-1", "EXP-9"] }, candidates), null);
  assert.equal(quickContinuation({ name: "Ship Billing Export", ticketKeys: [] }, [...candidates, { id: "c", title: "Ship billing export", ticket_keys: [] }]), null);
});

function fixture(t: { after: (fn: () => void) => void }, likelihood?: number) {
  const dir = mkdtempSync(join(tmpdir(), "acd-continuation-"));
  const store = new Store(join(dir, "workspace.sqlite"));
  const encryption: SecretEncryption = { available: () => true, encrypt: async v => Buffer.from(v), decrypt: async v => v.toString() };
  const calls: MatchPayload[] = [];
  const client: typeof requestMatch = async payload => {
    calls.push(payload);
    const target = payload.tasks.find(task => task.title === "Ship Billing Export")!.id, rest = (1 - (likelihood ?? 0)) / payload.tasks.length;
    return { output: parseOutput(JSON.stringify({
      task_likelihoods: payload.tasks.map(task => ({ task_id: task.id, likelihood: task.id === target ? (likelihood ?? 0) : 0 })),
      no_match_likelihood: 1 - (likelihood ?? 0), insufficient_context: false, reason: `Same work, ${rest}` }), payload),
      metadata: { model: null, provider: null, latency_ms: 1, prompt_tokens: null, completion_tokens: null, cost_usd: null } };
  };
  const matcher = new ChatMatcher(store, { openrouter: new SecretStore(join(dir, "o.enc"), encryption), bedrock: new SecretStore(join(dir, "b.enc"), encryption) }, () => {}, false, client);
  t.after(() => { matcher.dispose(); store.close(); removeFixture(dir); });
  const plans = new PlanningStore(store);
  store.command({ type: "importDailyPlan", card: "date: 2026-10-08\ncoding:\n  - name: Old unfinished\n  - name: Old done\n", sourceName: "fixture", itemIds: [null, null] });
  const old = plans.items();
  store.command({ type: "setPlanWorkedOn", id: old.find(i => i.name === "Old done")!.id, day: "2026-10-08", workedOn: true });
  store.command({ type: "importDailyPlan", card: "date: 2026-10-09\ncoding:\n  - name: Ship Billing Export\n    tickets: [EXP-1]\nother:\n  - Reply to Slack\n", sourceName: "fixture", itemIds: [null, null] });
  return { store, plans, matcher, calls, enable: () => matcher.save(matchingConfigSchema.parse({ enabled: true, model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER }), "synthetic-key") };
}

test("candidates are the previous card plus unfinished tasks from earlier cards, never the card's own day", t => {
  const f = fixture(t);
  const titles = f.plans.continuationCandidates("2026-10-12").map(c => c.title);
  assert.deepEqual(titles, ["Ship Billing Export", "Reply to Slack", "Old unfinished"]);
  assert.deepEqual(f.plans.continuationCandidates("2026-10-09").map(c => c.title), ["Old unfinished", "Old done"]);
  assert.deepEqual(f.plans.continuationCandidates("2026-10-08"), []);
});

test("model suggestions are confident, tentative or absent, and are off until matching is enabled", async t => {
  const f = fixture(t, 0.97);
  const candidates = f.plans.continuationCandidates("2026-10-12"), tasks = asTasks(candidates);
  const entry = { name: "Finalise Billing Export", text: "Finalise Billing Export\nTickets: EXP-1" };
  assert.equal((await f.matcher.suggestContinuation("2026-10-12", entry, tasks)).strength, "none");
  assert.equal(f.calls.length, 0);
  await f.enable();
  const confident = await f.matcher.suggestContinuation("2026-10-12", entry, tasks);
  assert.deepEqual([confident?.strength, confident?.source, confident?.itemId], ["suggested", "model", candidates[0].id]);
  assert.equal(f.calls[0].purpose, "continuation");
  assert.equal(f.calls[0].chat.latest_round.prompt, entry.text);
  assert.equal(f.matcher.status().running, false);
});

test("a middling model answer is only a hint and a weak one is dropped", async t => {
  for (const [likelihood, strength] of [[0.6, "maybe"], [0.3, "none"]] as const) {
    const f = fixture(t, likelihood);
    await f.enable();
    const result = await f.matcher.suggestContinuation("2026-10-12", { name: "Finalise Billing Export", text: "Finalise Billing Export" }, asTasks(f.plans.continuationCandidates("2026-10-12")));
    assert.equal(result?.strength, strength);
  }
});

test("card-entry suggestions are logged separately from chat matches and explain abstentions", async t => {
  const f = fixture(t, 0.3);
  await f.enable();
  const result = await f.matcher.suggestContinuation("2026-10-12", { name: "Finalise Billing Export", text: "Finalise Billing Export" }, asTasks(f.plans.continuationCandidates("2026-10-12")));
  assert.equal(result.reason, "The model thinks this is new work");
  const summary = f.matcher.status().analytics;
  assert.equal(summary.recent[0].purpose, "continuation");
  assert.equal(summary.chats, 0);
  const off = fixture(t, 0.97);
  assert.match((await off.matcher.suggestContinuation("2026-10-12", { name: "x", text: "x" }, asTasks(off.plans.continuationCandidates("2026-10-12")))).reason, /matching is off/);
});

const cardOf = (day: string, ...rows: string[]) => ["date: " + day, "coding:", ...rows].join(String.fromCharCode(10));
test("tasks sharing a ticket are one candidate, led by the most recent name, so the model's answer is not split", t => {
  const f = fixture(t);
  f.store.command({ type: "importDailyPlan", card: cardOf("2026-10-10", "  - name: Finalise Billing Export", "    tickets: [EXP-7]", "  - name: Unrelated"), sourceName: "fixture", itemIds: [null, null] });
  f.store.command({ type: "importDailyPlan", card: cardOf("2026-10-11", "  - name: Billing Export rollout", "    tickets: [EXP-7, EXP-8]", "  - name: Billing Export docs", "    tickets: [EXP-8]"), sourceName: "fixture", itemIds: [null, null] });
  const all = f.plans.continuationCandidates("2026-10-12");
  const merged = all.find(c => c.title === "Billing Export rollout")!;
  assert.deepEqual([...merged.aliases].sort(), ["Billing Export docs", "Finalise Billing Export"]);
  assert.deepEqual([...merged.ticket_keys].sort(), ["EXP-7", "EXP-8"]);
  assert.equal(merged.memberIds.length, 3);
  assert.equal(all.filter(c => /rollout|docs|Finalise/.test(c.title)).length, 1);
  // An older name still identifies the merged task, and a ticket now resolves to it instead of being ambiguous.
  assert.equal(quickContinuation({ name: "finalise billing export", ticketKeys: [] }, all)?.itemId, merged.id);
  assert.equal(quickContinuation({ name: "Something", ticketKeys: ["EXP-8"] }, all)?.itemId, merged.id);
});

test("names a task had on earlier cards count as its aliases", t => {
  const f = fixture(t);
  const item = f.plans.items().find(i => i.name === "Ship Billing Export")!;
  f.store.command({ type: "importDailyPlan", card: cardOf("2026-10-10", "  - name: Finalise Billing Export"), sourceName: "fixture", itemIds: [item.id] });
  const found = f.plans.continuationCandidates("2026-10-12").find(c => c.id === item.id)!;
  assert.equal(found.title, "Finalise Billing Export");
  assert.deepEqual(found.aliases, ["Ship Billing Export"]);
  assert.equal(quickContinuation({ name: "ship billing export", ticketKeys: [] }, [found])?.itemId, item.id);
});
