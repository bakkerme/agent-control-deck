import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { adaptOutput, decisionRequest, prepareSuite, fixturesFor, datasetHash, scoreTrial, summarize } from "./local.mjs";

const prepared = prepareSuite("smoke", "ticket-over-repository")[0];
function response(probabilities = { candidate_0: 0.02, candidate_1: 0.95, candidate_2: 0.01, no_match: 0.02 }, sufficient = 0.99) {
  return { answers: { task: { type: "choice", probabilities }, context: { type: "choice", probabilities: { sufficient, insufficient: 1 - sufficient } } } };
}

test("smoke and stress suites validate without modifying reused fixtures", () => {
  assert.equal(prepareSuite("smoke").length, 23);
  assert.equal(prepareSuite("stress").length, 26);
  assert.equal(prepareSuite("smoke").filter(p => p.skip).length, 3);
  assert.equal(prepareSuite("smoke", "dismissed-pair")[0].payload.tasks.some(t => t.id === "payments"), false);
  assert.deepEqual(fixturesFor().slice(0, 15), fixturesFor().slice(0, 15));
  assert.throws(() => prepareSuite("unknown"), /suite/);
  assert.throws(() => prepareSuite("smoke", "unknown"), /Unknown case/);
});

test("model requests contain evidence and choices but never golden labels or local dismissals", () => {
  const request = decisionRequest(prepared.payload), text = JSON.stringify(request);
  assert.equal(text.includes("link_task_id"), false);
  assert.equal(text.includes("expected"), false);
  assert.equal(text.includes("existing_links"), false);
  assert.equal(text.includes("dismissed_task_ids"), false);
  assert.deepEqual(request.state.chat, prepared.payload.chat);
  assert.deepEqual(Object.keys(request.questions.task.criteria), ["candidate_0", "candidate_1", "candidate_2", "no_match"]);
});

test("option labels cannot collide with user task IDs, including no_match", () => {
  const payload = structuredClone(prepared.payload);
  payload.tasks[0].id = "no_match";
  const output = adaptOutput(response(), payload);
  assert.equal(output.task_likelihoods[0].task_id, "no_match");
  assert.equal(output.no_match_likelihood, 0.02);
});

test("valid choice scores feed the exact desktop decision policy", () => {
  const result = scoreTrial({ case: prepared.fixture.id, raw: response(), iteration: 1 }, prepared);
  assert.equal(result.passed, true);
  assert.equal(result.decision.task_id, "payments");
  assert.ok(result.brier < 0.01);
});

test("context gate blocks a confident task score and its boundary is explicit", () => {
  assert.equal(adaptOutput(response(undefined, 0.899), prepared.payload).insufficient_context, true);
  assert.equal(adaptOutput(response(undefined, 0.9), prepared.payload).insufficient_context, false);
});

test("missing, extra, nonfinite, string and unnormalised probabilities fail closed", () => {
  for (const change of [
    r => delete r.answers.task.probabilities.candidate_0,
    r => r.answers.task.probabilities.unknown = 0,
    r => r.answers.task.probabilities.no_match = NaN,
    r => r.answers.task.probabilities.no_match = "0.02",
    r => r.answers.task.probabilities.no_match = 0.5,
    r => r.answers.task.probabilities.candidate_1 = -1,
    r => r.answers.context.probabilities.sufficient = 2,
    r => r.answers.context.type = "noul",
    r => r.answers.task.error = "max_length_exceeded",
  ]) {
    const raw = response(); change(raw);
    assert.throws(() => adaptOutput(raw, prepared.payload));
    const scored = scoreTrial({ case: prepared.fixture.id, raw }, prepared);
    assert.equal(scored.passed, false);
    assert.equal(scored.decision, undefined);
  }
});

test("dataset fingerprints cover labels, candidate order and local preservation rules", () => {
  const original = prepareSuite("smoke");
  assert.equal(datasetHash(original), datasetHash(prepareSuite("smoke")));
  const changed = structuredClone(original); changed[0].fixture.expected.link_task_id = "portal";
  assert.notEqual(datasetHash(original), datasetHash(changed));
});

test("metrics penalise wrong links and keep abstentions, failures and local skips distinct", () => {
  const correct = scoreTrial({ case: "ticket", iteration: 1, raw: response(), temperature: "warm", latency_ms: 10 }, prepared);
  const wrong = scoreTrial({ case: "ticket", iteration: 2, raw: response({ candidate_0: 0.95, candidate_1: 0.02, candidate_2: 0.01, no_match: 0.02 }), temperature: "warm", latency_ms: 30 }, prepared);
  const failure = scoreTrial({ case: "failure", error: "timeout" }, prepared);
  const metrics = summarize([correct, wrong, failure, { passed: true, decision: { action: "skip" } }]);
  assert.equal(metrics.link_precision, 0.5);
  assert.equal(metrics.errors, 1);
  assert.equal(metrics.inference_trials, 3);
  assert.equal(metrics.link_recall, 1 / 3);
  assert.equal(metrics.warm_latency_p50_ms, 10);
  assert.equal(metrics.warm_latency_p95_ms, 30);
  assert.equal(metrics.cases_with_changed_decision, 1);
});

test("a model that always abstains cannot claim perfect link precision or useful recall", () => {
  const r = scoreTrial({ case: "ticket", raw: response({ candidate_0: 0.25, candidate_1: 0.3, candidate_2: 0.2, no_match: 0.25 }) }, prepared);
  const metrics = summarize([r]);
  assert.equal(metrics.link_precision, null);
  assert.equal(metrics.link_recall, 0);
  assert.equal(metrics.abstention_rate, 1);
});

test("CLI defaults stay offline even with a model path and cloud credentials", () => {
  const secret = "test-secret-local-eval";
  const run = spawnSync(process.execPath, ["scripts/chat-task-eval/run-local.mjs", "--model-path", "does-not-exist"], {
    encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: secret },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /DRY RUN/);
  assert.match(run.stdout, /No model loaded, downloaded, or evaluated/);
  assert.equal((run.stdout + run.stderr).includes(secret), false);
});

test("CLI rejects invalid settings and missing live checkpoint before model work", () => {
  for (const args of [["--repeat", "0"], ["--threads", "0"], ["--context-threshold", "NaN"], ["--case", "missing"], ["--live"]]) {
    const run = spawnSync(process.execPath, ["scripts/chat-task-eval/run-local.mjs", ...args], { encoding: "utf8" });
    assert.equal(run.status, 1);
  }
});

test("worker-launch failure retains a readable incomplete report and counts unrun trials", () => {
  const run = spawnSync(process.execPath, ["scripts/chat-task-eval/run-local.mjs", "--live", "--case", "ticket-over-repository", "--model-path", "does-not-exist", "--python", "missing-local-eval-python-executable"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  const file = run.stdout.match(/Report: (.+)/)?.[1];
  assert.ok(file, run.stderr);
  const report = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(report.status, "incomplete");
  assert.equal(report.summary.unrun_trials, 1);
  assert.equal(report.summary.valid_responses, 0);
  assert.match(report.worker_error, /Worker launch failed/);
});
