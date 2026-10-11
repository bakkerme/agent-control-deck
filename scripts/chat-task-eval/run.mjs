import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CASES } from "./cases.mjs";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_BEDROCK_MODEL, DEFAULT_BEDROCK_REGION, PROMPT_VERSION, THRESHOLDS, SYSTEM_PROMPT,
  prepareInput, requestMatch, decide, evaluate } from "./matching.mjs";

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: "boolean", default: false },
    backend: { type: "string", default: "openrouter" },
    case: { type: "string" },
    repeat: { type: "string", default: "1" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("npm run eval:matching -- [--live] [--backend openrouter|bedrock] [--case CASE_ID] [--repeat 1..5]\nDefault: validate synthetic fixtures without API calls. --live requires OPENROUTER_API_KEY or AWS_BEARER_TOKEN_BEDROCK for the selected backend.");
    return;
  }
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error("--repeat must be an integer from 1 to 5");
  const selected = values.case ? CASES.filter(item => item.id === values.case) : CASES;
  if (!selected.length) throw new Error("Unknown case ID; see scripts/chat-task-eval/cases.mjs");
  const backend = values.backend;
  if (!["openrouter", "bedrock"].includes(backend)) throw new Error("--backend must be openrouter or bedrock");
  const region = process.env.BEDROCK_REGION?.trim() || DEFAULT_BEDROCK_REGION;
  if (backend === "bedrock" && !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) throw new Error("Invalid BEDROCK_REGION");
  const model = backend === "bedrock" ? process.env.BEDROCK_MODEL?.trim() || DEFAULT_BEDROCK_MODEL : process.env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const provider = backend === "bedrock" ? "Amazon Bedrock" : process.env.OPENROUTER_PROVIDER?.trim() || DEFAULT_PROVIDER;
  const prepared = selected.map(fixture => ({ fixture, ...prepareInput(fixture.payload, fixture.context) }));
  const calls = prepared.filter(item => !item.skip).length * repeat;
  console.log(`${values.live ? "LIVE" : "DRY RUN"}: model=${model}, provider=${provider}, cases=${selected.length}, repeat=${repeat}, planned API calls=${values.live ? calls : 0}`);
  if (!values.live) {
    console.table(prepared.map(({ fixture, payload, skip }) => ({ case: fixture.id, candidates: payload.tasks.length, expected: fixture.expected.link_task_id ?? "unassigned", action: skip ?? "ready", payload_chars: JSON.stringify(payload).length })));
    console.log(`Validated fixtures; a live run would make ${calls} requests. No model quality has been measured.`);
    return;
  }
  const apiKey = backend === "bedrock" ? process.env.AWS_BEARER_TOKEN_BEDROCK : process.env.OPENROUTER_API_KEY;
  if (calls && !apiKey?.trim()) throw new Error(`Set ${backend === "bedrock" ? "AWS_BEARER_TOKEN_BEDROCK" : "OPENROUTER_API_KEY"} in your shell or ignored .env.local, then rerun with --live`);
  const report = { prompt_version: PROMPT_VERSION, system_prompt: SYSTEM_PROMPT, backend, region: backend === "bedrock" ? region : null, model, provider, thresholds: THRESHOLDS,
    started_at: new Date().toISOString(), results: [] };
  for (let iteration = 1; iteration <= repeat; iteration++) {
    for (const { fixture, payload, skip } of prepared) {
      let result;
      if (skip) {
        const decision = { task_id: null, action: "skip", reason: skip };
        result = { case: fixture.id, iteration, expected: fixture.expected, decision, ...evaluate(fixture, null, decision) };
      } else {
        try {
          const { output, metadata } = await requestMatch(payload, { apiKey, model, provider, backend, region, syntheticDiagnostics: true });
          const decision = decide(output);
          result = { case: fixture.id, iteration, expected: fixture.expected, payload, output, metadata, decision, ...evaluate(fixture, output, decision) };
        } catch (error) {
          result = { case: fixture.id, iteration, expected: fixture.expected, passed: false, error: error.message };
        }
      }
      report.results.push(result);
      console.log(`${result.passed ? "PASS" : "FAIL"} ${fixture.id} #${iteration}: ${result.error ?? `${result.decision.action}/${result.decision.reason}${result.decision.task_id ? ` → ${result.decision.task_id}` : ""}`}`);
      // Stop on contract, transport or authentication errors to avoid wasting further calls.
      if (result.error) break;
    }
    if (report.results.at(-1)?.error) break;
  }
  const modelResults = report.results.filter(item => item.output);
  const scored = modelResults.filter(item => item.brier !== null);
  const links = modelResults.filter(item => item.decision.action === "link");
  const knownCosts = modelResults.filter(item => typeof item.metadata.cost_usd === "number");
  const attemptedRequests = report.results.filter(item => item.decision?.action !== "skip").length;
  report.summary = {
    cases_run: report.results.length, passed: report.results.filter(item => item.passed).length,
    model_responses: modelResults.length, auto_links: links.length,
    attempted_requests: attemptedRequests,
    correct_auto_links: links.filter(item => item.decision.task_id === item.expected.link_task_id).length,
    labelled_responses: scored.length,
    mean_brier: scored.length ? scored.reduce((sum, item) => sum + item.brier, 0) / scored.length : null,
    reported_cost_usd: knownCosts.length ? knownCosts.reduce((sum, item) => sum + item.metadata.cost_usd, 0) : null,
    cost_unavailable_requests: attemptedRequests - knownCosts.length,
  };
  const directory = resolve("test-results", "matching");
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `eval-${report.started_at.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${file}\nLikelihoods are model estimates; this small synthetic suite does not establish calibration or direct Bedrock parity.`);
  if (report.results.some(item => !item.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
