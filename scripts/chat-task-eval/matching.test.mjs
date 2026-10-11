import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { CASES } from "./cases.mjs";
import { prepareInput, parseOutput, decide, buildRequest, buildBedrockRequest, requestMatch, evaluate, DEFAULT_PROVIDER } from "./matching.mjs";

const payload = prepareInput(CASES[0].payload).payload;
const valid = {
  task_likelihoods: [{ task_id: "portal", likelihood: 0.03 }, { task_id: "payments", likelihood: 0.93 }, { task_id: "team", likelihood: 0.01 }],
  no_match_likelihood: 0.03, insufficient_context: false, reason: "The prompt names PAY-142 and webhook delivery.",
};
const output = patch => ({ ...structuredClone(valid), ...patch });
function probabilities(portal, payments, team, none) {
  return output({ task_likelihoods: [{ task_id: "portal", likelihood: portal }, { task_id: "payments", likelihood: payments }, { task_id: "team", likelihood: team }], no_match_likelihood: none });
}

test("all labelled fixtures validate and only unbound eligible cases need requests", () => {
  const prepared = CASES.map(fixture => prepareInput(fixture.payload, fixture.context));
  assert.equal(prepared.filter(item => !item.skip).length, 12);
  assert.equal(prepared.filter(item => item.skip).length, 3);
});
test("an explicit ticket can beat a misleading chat title and repository", () => {
  const parsed = parseOutput(JSON.stringify(valid), payload);
  const decision = decide(parsed);
  assert.equal(decision.task_id, "payments");
  assert.equal(evaluate(CASES[0], parsed, decision).passed, true);
});
test("overlapping tasks abstain, regardless of candidate ordering", () => {
  const parsed = parseOutput(JSON.stringify(probabilities(0.48, 0.48, 0.01, 0.03)), payload);
  assert.equal(decide(parsed).task_id, null);
  assert.equal(decide(parsed).reason, "uncertain");
  parsed.task_likelihoods.reverse();
  assert.equal(decide(parsed).task_id, null);
});
test("no match competes with task options and never causes a link", () => {
  assert.equal(decide(probabilities(0.01, 0.02, 0.01, 0.96)).reason, "no_match");
});
test("insufficient context blocks even a very high score", () => {
  const result = decide(output({ insufficient_context: true }));
  assert.equal(result.task_id, null);
  assert.equal(result.reason, "insufficient_context");
});
test("threshold boundary links; a score just below it abstains", () => {
  assert.equal(decide(probabilities(0.05, 0.9, 0.02, 0.03)).task_id, "payments");
  assert.equal(decide(probabilities(0.05, 0.899, 0.02, 0.031)).task_id, null);
});
test("margin includes no match and blocks a near tie with custom thresholds", () => {
  assert.equal(decide(probabilities(0.01, 0.6, 0.01, 0.38), { likelihood: 0.5, margin: 0.25 }).task_id, null);
});
test("manual and existing automatic links skip inference rather than move silently", () => {
  for (const origin of ["manual", "ai"]) {
    assert.equal(prepareInput(payload, { existing_links: [{ task_id: "portal", origin }] }).skip, "preserve_existing");
  }
});
test("dismissal removes only that chat/task candidate and does not mutate the fixture", () => {
  const { payload: filtered } = prepareInput(payload, { dismissed_task_ids: ["payments"] });
  assert.deepEqual(filtered.tasks.map(task => task.id), ["portal", "team"]);
  assert.equal(payload.tasks.length, 3);
  assert.equal(prepareInput(payload, { dismissed_task_ids: ["portal", "payments", "team"] }).skip, "no_candidates");
});
test("invalid or duplicate input candidates fail before any API call", () => {
  assert.throws(() => prepareInput({ ...payload, tasks: [...payload.tasks, payload.tasks[0]] }), /Duplicate/);
  assert.throws(() => prepareInput({ ...payload, plan_day: "2026-99-99" }), /Invalid matching payload/);
  assert.throws(() => prepareInput({ ...payload, secret: "extra field" }), /Invalid matching payload/);
});

for (const [name, change] of [
  ["unknown task ID", value => value.task_likelihoods[0].task_id = "invented"],
  ["duplicate task ID", value => value.task_likelihoods[0].task_id = "payments"],
  ["missing candidate", value => value.task_likelihoods.pop()],
  ["negative likelihood", value => value.task_likelihoods[0].likelihood = -0.1],
  ["likelihood above one", value => value.no_match_likelihood = 1.2],
  ["string likelihood", value => value.no_match_likelihood = "0.03"],
  ["wrong total", value => value.no_match_likelihood = 0.5],
  ["missing context flag", value => delete value.insufficient_context],
  ["unexpected action", value => value.action = "delete task"],
  ["unbounded reason", value => value.reason = "x".repeat(241)],
]) {
  test(`rejects ${name} instead of applying a decision`, () => {
    const value = output({}); change(value);
    assert.throws(() => parseOutput(JSON.stringify(value), payload));
  });
}
test("malformed JSON and markdown-wrapped JSON are not repaired into decisions", () => {
  assert.throws(() => parseOutput("not JSON", payload), /invalid JSON/);
  assert.throws(() => parseOutput("```json\n" + JSON.stringify(valid) + "\n```", payload), /invalid JSON/);
});
test("request pins the chosen provider with no fallback and keeps labels out of the prompt", () => {
  const request = buildRequest(payload);
  assert.deepEqual(request.provider, { only: [DEFAULT_PROVIDER], allow_fallbacks: false, require_parameters: true });
  assert.equal(request.response_format.json_schema.strict, true);
  assert.deepEqual(JSON.parse(request.messages[1].content), payload);
  assert.equal(request.messages[1].content.includes("link_task_id"), false);
});

function envelope(options = {}) {
  return { model: "openai/gpt-6-luna", provider: "Amazon Bedrock", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(valid) } }],
    usage: { prompt_tokens: 500, completion_tokens: 80, cost: 0.0001 }, ...options };
}
const response = body => ({ ok: true, json: async () => body });
test("mocked OpenRouter request returns validated scores and usage without storing the key", async () => {
  const key = "test-key-not-a-real-credential";
  const result = await requestMatch(payload, { apiKey: key, fetchImpl: async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    assert.equal(init.body.includes(key), false);
    assert.equal(init.signal.aborted, false);
    return response(envelope());
  } });
  assert.equal(result.output.task_likelihoods[1].likelihood, 0.93);
  assert.equal(result.metadata.cost_usd, 0.0001);
  assert.equal(JSON.stringify(result).includes(key), false);
});
test("missing key fails without calling the network", async () => {
  await assert.rejects(requestMatch(payload, { fetchImpl: () => { throw new Error("network called"); } }), /OPENROUTER_API_KEY/);
});
test("Bedrock calls AWS directly with the same prompt and schema, without OpenRouter routing", async () => {
  const request = buildBedrockRequest(payload), openrouter = buildRequest(payload);
  assert.deepEqual(request.messages, openrouter.messages);
  assert.deepEqual(request.response_format, openrouter.response_format);
  assert.equal(request.model, "global.openai.gpt-6-luna");
  assert.equal(request.provider, undefined); assert.equal(request.max_tokens, undefined);
  assert.equal(request.max_completion_tokens, 2048);
  const result = await requestMatch(payload, { backend: "bedrock", apiKey: "bedrock-synthetic", region: "ap-southeast-2", fetchImpl: async (url, init) => {
    assert.equal(url, "https://bedrock-runtime.ap-southeast-2.amazonaws.com/openai/v1/chat/completions");
    assert.equal(init.headers.Authorization, "Bearer bedrock-synthetic");
    assert.equal(init.headers["X-OpenRouter-Title"], undefined);
    assert.equal(init.redirect, "error");
    assert.deepEqual(JSON.parse(init.body), request);
    return response(envelope({ provider: undefined, usage: { prompt_tokens: 100, completion_tokens: 40 } }));
  } });
  assert.equal(result.metadata.provider, "Amazon Bedrock");
  assert.equal(result.metadata.cost_usd, null);
  assert.equal(decide(result.output).task_id, "payments");
});
test("Bedrock failures never retry or send credentials to OpenRouter", async () => {
  let calls = 0;
  await assert.rejects(requestMatch(payload, { backend: "bedrock", apiKey: "test", fetchImpl: async url => {
    calls++; assert.ok(String(url).includes("amazonaws.com"));
    return { ok: false, status: 403, json: () => { throw new Error("private body"); } };
  } }), /^Error: Bedrock HTTP 403 \(no retry\)$/);
  assert.equal(calls, 1);
  await assert.rejects(requestMatch(payload, { backend: "bedrock", apiKey: "test", region: "us-east-1.evil.example", fetchImpl: () => { throw new Error("must not send"); } }), /Invalid Bedrock region/);
});
test("authentication and network failures do not retry or expose error bodies", async () => {
  let calls = 0;
  await assert.rejects(requestMatch(payload, { apiKey: "test", fetchImpl: async () => {
    calls++; return { ok: false, status: 401, json: () => { throw new Error("must not read a potentially sensitive body"); } };
  } }), /^Error: OpenRouter HTTP 401 \(no retry\)$/);
  assert.equal(calls, 1);
  await assert.rejects(requestMatch(payload, { apiKey: "test", fetchImpl: async () => { throw new Error("private text"); } }), /^Error: OpenRouter request failed or timed out \(no retry\)$/);
});
test("synthetic connection errors include AWS's explanation and request ID, with credentials redacted before truncation", async () => {
  const key = "ABSKsyntheticPrivateBearerToken", otherKey = "sk-another-private-token";
  let calls = 0;
  await assert.rejects(requestMatch(payload, { backend: "bedrock", apiKey: key, syntheticDiagnostics: true, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ __type: "ValidationException", message: `Model access is unavailable. Bearer ${key} ${otherKey} ${"x".repeat(1000)}`, private: "Do not echo arbitrary fields" }),
      { status: 400, headers: { "x-amzn-requestid": "synthetic-request-123" } });
  } }), error => {
    assert.match(error.message, /Bedrock HTTP 400.*ValidationException.*Model access is unavailable/);
    assert.equal(error.message.includes(key), false);
    assert.equal(error.message.includes(otherKey), false);
    assert.equal(error.message.includes("Do not echo arbitrary fields"), false);
    assert.ok(error.message.length < 850);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(requestMatch(payload, { backend: "bedrock", apiKey: key, syntheticDiagnostics: true, fetchImpl: async () =>
    new Response(JSON.stringify({ error: { code: "ValidationException", message: "Unknown inference profile" } }), { status: 400, headers: { "x-amzn-requestid": "synthetic-request-123" } })
  }), /Unknown inference profile.*request synthetic-request-123/);
});
test("synthetic diagnostics ignore malformed or oversized error bodies and cancel the bounded stream", async () => {
  for (const body of ["<html>untrusted body</html>", JSON.stringify({ message: "x".repeat(17000) }), JSON.stringify({ message: { sensitive: "not a string" } })]) {
    await assert.rejects(requestMatch(payload, { apiKey: "synthetic-key", syntheticDiagnostics: true, fetchImpl: async () => new Response(body, { status: 400 }) }),
      /^Error: OpenRouter HTTP 400 \(no retry\)$/);
  }
  let cancelled = false;
  await assert.rejects(requestMatch(payload, { apiKey: "synthetic-key", syntheticDiagnostics: true, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(17000)); }, cancel() { cancelled = true; },
  }), { status: 400 }) }), /^Error: OpenRouter HTTP 400 \(no retry\)$/);
  assert.equal(cancelled, true);
});
test("incomplete, refused, error and malformed envelopes fail closed", async () => {
  for (const body of [
    envelope({ choices: [{ finish_reason: "length", message: { content: JSON.stringify(valid) } }] }),
    envelope({ choices: [{ finish_reason: "stop", message: { refusal: "refused", content: "" } }] }),
    { error: { message: "private text" } }, {}, null, [],
  ]) {
    await assert.rejects(requestMatch(payload, { apiKey: "test", fetchImpl: async () => response(body) }));
  }
});
test("wrong confident links fail the eval and definite labels have a Brier score", () => {
  const incorrect = probabilities(0.93, 0.03, 0.01, 0.03);
  assert.equal(evaluate(CASES[0], incorrect, decide(incorrect)).passed, false);
  assert.ok(evaluate(CASES[0], valid, decide(valid)).brier < evaluate(CASES[0], incorrect, decide(incorrect)).brier);
  const ambiguous = CASES.find(item => item.id === "overlapping-tasks");
  assert.equal(evaluate(ambiguous, valid, decide(valid)).brier, null);
});
test("a definite no-match label must win, rather than pass through low-confidence abstention", () => {
  const fixture = CASES.find(item => item.id === "no-matching-task");
  const uncertainWrongMatch = probabilities(0.6, 0.1, 0.1, 0.2);
  assert.equal(decide(uncertainWrongMatch).task_id, null);
  assert.equal(evaluate(fixture, uncertainWrongMatch, decide(uncertainWrongMatch)).passed, false);
  const correct = probabilities(0.01, 0.02, 0.01, 0.96);
  assert.equal(evaluate(fixture, correct, decide(correct)).passed, true);
});
test("default CLI run is offline even when a key is present", () => {
  const secret = "test-secret-never-log";
  const result = spawnSync(process.execPath, ["scripts/chat-task-eval/run.mjs"], { encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: secret } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN.*API calls=0/);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
});
test("live CLI requires a key and exits before sending requests", () => {
  const result = spawnSync(process.execPath, ["scripts/chat-task-eval/run.mjs", "--live", "--case", "ticket-over-repository"], { encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: "" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set OPENROUTER_API_KEY/);
});
test("Bedrock CLI stays offline by default and never uses an OpenRouter key as a Bedrock token", () => {
  const env = { ...process.env, OPENROUTER_API_KEY: "synthetic-or-key", AWS_BEARER_TOKEN_BEDROCK: "", BEDROCK_REGION: "ap-southeast-2" };
  const dry = spawnSync(process.execPath, ["scripts/chat-task-eval/run.mjs", "--backend", "bedrock"], { encoding: "utf8", env });
  assert.equal(dry.status, 0); assert.match(dry.stdout, /DRY RUN.*API calls=0/);
  const live = spawnSync(process.execPath, ["scripts/chat-task-eval/run.mjs", "--backend", "bedrock", "--live"], { encoding: "utf8", env });
  assert.equal(live.status, 1); assert.match(live.stderr, /Set AWS_BEARER_TOKEN_BEDROCK/);
  assert.equal((dry.stdout + live.stderr).includes(env.OPENROUTER_API_KEY), false);
});
