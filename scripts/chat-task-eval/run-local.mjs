import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { prepareSuite, decisionRequest, datasetHash, scoreTrial, summarize, MODEL_ID, LOCAL_PROMPT_VERSION, CONTEXT_THRESHOLD } from "./local.mjs";
import { THRESHOLDS, evaluate } from "./matching.mjs";

const here = dirname(fileURLToPath(import.meta.url));
function integer(value, name, min, max) {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`--${name} must be ${min}..${max}`);
  return Number(value);
}

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: "boolean", default: false }, help: { type: "boolean", default: false },
    suite: { type: "string", default: "smoke" }, case: { type: "string" },
    repeat: { type: "string", default: "1" }, threads: { type: "string", default: "4" },
    warmup: { type: "string", default: "1" }, timeout: { type: "string", default: "600" },
    "context-threshold": { type: "string", default: String(CONTEXT_THRESHOLD) },
    "model-path": { type: "string" }, python: { type: "string", default: process.platform === "win32" ? "python" : "python3" },
  } });
  if (values.help) {
    console.log("npm run eval:matching:local -- [--live --model-path LOCAL_DIRECTORY --python PYTHON] [--suite smoke|stress] [--case ID] [--repeat 1..5] [--threads 1..64] [--warmup 0..3] [--timeout SECONDS] [--context-threshold 0..1]\nDefault validates synthetic cases offline. Live inference is CPU-only and never downloads a model.");
    return;
  }
  const repeat = integer(values.repeat, "repeat", 1, 5), threads = integer(values.threads, "threads", 1, 64);
  const warmup = integer(values.warmup, "warmup", 0, 3), timeout = integer(values.timeout, "timeout", 1, 7200);
  const contextThreshold = Number(values["context-threshold"]);
  if (!values["context-threshold"].trim() || !Number.isFinite(contextThreshold) || contextThreshold < 0 || contextThreshold > 1) throw new Error("Invalid --context-threshold");
  const prepared = prepareSuite(values.suite, values.case);
  const jobs = prepared.filter(p => !p.skip).map(p => ({ case: p.fixture.id, request: decisionRequest(p.payload) }));
  console.log(`${values.live ? "LIVE CPU" : "DRY RUN"}: ${MODEL_ID}; cases=${prepared.length}; inference trials=${jobs.length * repeat}; threads=${threads}`);
  if (!values.live) {
    console.table(prepared.map(p => ({ case: p.fixture.id, candidates: p.payload.tasks.length, action: p.skip ?? "ready", expected: p.fixture.expected.link_task_id ?? "unassigned" })));
    console.log(`Dataset SHA-256: ${datasetHash(prepared)}\nNo model loaded, downloaded, or evaluated.`);
    return;
  }
  if (jobs.length && !values["model-path"]) throw new Error("--live requires --model-path; see docs/local-decision-eval.md");
  const started = new Date().toISOString();
  const directory = resolve("test-results", "matching-local", started.replace(/[:.]/g, "-") + `-${process.pid}`);
  await mkdir(directory, { recursive: true });
  const inputPath = resolve(directory, "requests.json"), rawPath = resolve(directory, "raw.json"), reportPath = resolve(directory, "report.json");
  const input = { model_id: MODEL_ID, model_path: values["model-path"] ? resolve(values["model-path"]) : null, threads, repeat, warmup, jobs };
  await writeFile(inputPath, JSON.stringify(input, null, 2) + "\n", { flag: "wx" });
  const report = { schema_version: "local_matching_eval.v1", started_at: started, status: "running", model: MODEL_ID,
    prompt_version: LOCAL_PROMPT_VERSION, dataset_sha256: datasetHash(prepared), suite: values.suite,
    thresholds: THRESHOLDS, context_threshold: contextThreshold, fixtures: prepared.map(p => p.fixture), results: [] };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Evidence directory: ${directory}`);
  let failure = null, raw = { results: [] };
  if (jobs.length) {
    const child = spawn(values.python, [resolve(here, "local_worker.py"), "--input", inputPath, "--output", rawPath], {
      shell: false, stdio: ["ignore", "inherit", "inherit"],
      // Do not forward cloud credentials to the model worker.
      env: Object.fromEntries(Object.entries({ ...process.env, CUDA_VISIBLE_DEVICES: "", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" })
        .filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))),
    });
    failure = await new Promise(resolveDone => {
      let timedOut = false, forceTimer;
      const timer = setTimeout(() => {
        timedOut = true; child.kill();
        forceTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      }, timeout * 1000);
      const clearTimers = () => { clearTimeout(timer); clearTimeout(forceTimer); };
      child.once("error", error => { clearTimers(); resolveDone(`Worker launch failed: ${error.message}`); });
      child.once("close", (code, signal) => { clearTimers(); resolveDone(timedOut ? `Worker exceeded ${timeout}s timeout` : code === 0 ? null : `Worker exited ${code ?? signal}`); });
    });
    try {
      const checkpoint = JSON.parse(await readFile(rawPath, "utf8"));
      if (!checkpoint || !Array.isArray(checkpoint.results)) throw new Error("Invalid checkpoint results");
      raw = checkpoint;
    } catch { failure ??= "Worker did not produce a readable checkpoint"; }
  }
  report.runtime = raw.runtime ?? null; report.warmups = raw.warmups ?? [];
  report.worker_error = raw.error ?? failure;
  const byCase = new Map(prepared.filter(p => !p.skip).map(p => [p.fixture.id, p]));
  const seen = new Set();
  for (const trial of raw.results ?? []) {
    const key = JSON.stringify([trial?.case, trial?.iteration]);
    if (!trial || !byCase.has(trial.case) || !Number.isInteger(trial.iteration) || trial.iteration < 1 || trial.iteration > repeat || seen.has(key)) {
      failure ??= "Invalid or duplicate worker trial; see retained raw checkpoint";
      continue;
    }
    seen.add(key);
    report.results.push(scoreTrial(trial, byCase.get(trial.case), contextThreshold));
  }
  for (let iteration = 1; iteration <= repeat; iteration++) for (const p of prepared.filter(p => p.skip)) {
    const decision = { task_id: null, action: "skip", reason: p.skip };
    report.results.push({ case: p.fixture.id, iteration, expected: p.fixture.expected, decision, ...evaluate(p.fixture, null, decision) });
  }
  const complete = report.results.length === prepared.length * repeat && !failure && !raw.error;
  report.status = complete ? "complete" : "incomplete";
  report.worker_error ??= failure;
  report.finished_at = new Date().toISOString();
  report.summary = summarize(report.results);
  report.summary.planned_trials = prepared.length * repeat;
  report.summary.unrun_trials = prepared.length * repeat - report.results.length;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  for (const r of report.results) console.log(`${r.passed ? "PASS" : "FAIL"} ${r.case} #${r.iteration}: ${r.error ?? `${r.decision.action}/${r.decision.reason}`}`);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${reportPath}\nSynthetic results do not establish calibration, native bundling, or target-PC performance.`);
  if (!complete || report.results.some(r => !r.passed)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
