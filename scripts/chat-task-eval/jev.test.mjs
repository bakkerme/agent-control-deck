import test from "node:test";
import assert from "node:assert/strict";
import { requestJev, runJev, JEV_ENDPOINT, JEV_MODEL } from "./jev.mjs";
import { scoreRun, portableRequest } from "./benchmark-core.mjs";
import { prepareSuite } from "./local.mjs";

const response = body => new Response(JSON.stringify(body), { status: 200 });
const answer = { id: "test-id", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe", answers: {}, usage: { cost: .001 } };
test("Jev uses SystemOne with a fixed model and refuses to call without credentials", async () => {
  let called = false;
  await assert.rejects(requestJev({}, { fetchImpl: () => { called = true; } }), /OPENROUTER_API_KEY/);
  assert.equal(called, false);
  const request = portableRequest(prepareSuite("smoke", "ticket-over-repository")[0].payload);
  const raw = await requestJev(request, { apiKey: "private-test-key", fetchImpl: async (url, options) => {
    assert.equal(url, JEV_ENDPOINT); assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer private-test-key");
    assert.deepEqual(JSON.parse(options.body), { model: JEV_MODEL, ...request });
    assert.ok(!options.body.includes("expected")); assert.ok(!options.body.includes("private-test-key"));
    return response({ ...answer, echoed_secret: "private-test-key" });
  } });
  assert.equal(raw.model, answer.model); assert.equal(raw.echoed_secret, undefined);
});
test("provider, version, oversized and invalid responses fail with bounded evidence", async () => {
  for (const body of [{ ...answer, model: "another/model" }, { ...answer, provider: "another" }, { ...answer, model: null }])
    await assert.rejects(requestJev({}, { apiKey: "key", fetchImpl: async () => response(body) }), /identity|provider/);
  await assert.rejects(requestJev({}, { apiKey: "key", fetchImpl: async () => new Response("a".repeat(2 * 1024 * 1024 + 1)) }), /2 MiB/);
  await assert.rejects(requestJev({}, { apiKey: "key", fetchImpl: async () => new Response("bad JSON") }), /invalid JSON/);
});
test("remote failure is not retried and checkpoints completed, failed and unrun cases", async () => {
  const prepared = prepareSuite("smoke").filter(p => !p.skip).slice(0, 3);
  const jobs = prepared.map(p => ({ case: p.fixture.id, request: portableRequest(p.payload) }));
  const checkpoints = []; let calls = 0;
  const raw = await runJev(jobs, { apiKey: "private-test-key", checkpoint: async r => checkpoints.push(structuredClone(r)),
    fetchImpl: async () => ++calls === 1 ? response(answer) : new Response("private-test-key", { status: 401 }) });
  assert.equal(calls, 2); assert.equal(raw.results.length, 2); assert.match(raw.error, /HTTP 401/);
  assert.ok(!JSON.stringify(checkpoints).includes("private-test-key"));
  const scored = scoreRun(raw, prepared, 1);
  assert.equal(scored.status, "incomplete"); assert.equal(scored.summary.unrun_trials, 1);
  assert.equal(scored.summary.reported_cost_usd, .001); assert.equal(scored.summary.cost_available_trials, 1);
});
test("concise experiment retains evidence, labels and fixed confidence policy", () => {
  const p = prepareSuite("smoke", "local-long-prompt")[0], a = portableRequest(p.payload, "concise");
  assert.equal(a.state.request, p.payload.chat.latest_round.prompt);
  assert.equal(a.state.answer, undefined); // Empty response is absent, as Vela requires nonempty named parts.
  assert.match(a.state.context, /plan_day/);
  assert.deepEqual(a.questions.task.criteria, portableRequest(p.payload).questions.task.criteria);
  assert.ok(!JSON.stringify(a).includes('"expected"'));
  assert.equal(a.questions.context.criteria.sufficient, "Yes: the requested work has a clear subject.");
});
