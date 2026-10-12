import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { createWriteStream, realpathSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import os from "node:os";
import { runJev } from "./jev.mjs";
import { prepareSuite, datasetHash, CONTEXT_THRESHOLD } from "./local.mjs";
import { THRESHOLDS } from "./matching.mjs";
import { MODELS, PROMPT_VERSION, UV_VERSION, UV_INSTALLER_HASHES, pythonPath, portableRequest, scoreRun, renderReport } from "./benchmark-core.mjs";
import { prepareDataset, SYNTHETIC_DATASET } from "./dataset.mjs";
import { offlineEvaluation, validatePolicy, evaluatePolicy } from "./evaluation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hash = data => createHash("sha256").update(data).digest("hex");
const HELP = `Local decision model test — standalone, Node 24+ required.
Usage: node local-decision-test.mjs [options]
Default: install isolated Python 3.13 environments, download pinned Kai + Julia,
run 23 synthetic cases three times on CPU with four threads, write HTML + JSON.

  --work-dir PATH      Cache and reports (default: ./local-decision-test-data)
  --models LIST        kai,julia,vela,gliner,d3-edge,j33-jev,crivo-150m,jev (default: kai,julia)
  --adapter NAME      legacy (original) or concise (shorter questions)
  --jev-repeat 1      Remote repetitions; paid Jev calls only when selected
  --env-file PATH     Load OPENROUTER_API_KEY (default for Jev: .env.local)
  --threads 4         CPU threads, or a sequential sweep such as 2,4,8
  --repeat 3          Measured repetitions (1..5)
  --suite smoke       smoke or stress (large candidate sets)
  --case ID           Select one case
  --warmup 1          Warmup requests (0..3)
  --timeout 600       Timeout in seconds per evaluation (1..7200)
  --dry-run           Offline plan only; no installations or model inference
  --dataset PATH      Labelled JSON path, or embedded synthetic-v1 (40 cases)
  --split NAME        calibration or holdout; embedded fixtures stay regression
  --policy PATH       Frozen policy required for live holdout evaluation
  --analyze-report P  Offline independent metrics from an existing report
  --calibrate-report P  Fit thresholds using a calibration report only
  --policy-out PATH   New frozen policy file (never overwrites an existing file)
  --min-precision .98  Calibration target on distinct accepted cases
  --min-links 10      Minimum distinct accepted calibration/holdout cases
  --evaluate-report P  Evaluate a frozen --policy against a holdout report
  --analysis-out DIR  New analysis directory; originals are preserved
  --help              Show this help

Needs Internet on first run, ~2.2 GB model downloads plus runtimes, and several
GB free disk/RAM. Subsequent runs reuse verified downloads and environments.
Runs on macOS Apple Silicon, Windows x64 and Linux with supported CPU wheels.
Current PyTorch does not publish native Intel macOS wheels.
Exit: 0 all cases pass; 1 evaluation completed with quality failures;
2 setup, download, runtime or incomplete evaluation. Evidence is kept on failure.
Pinned checkpoints include custom Python code, which executes locally.
Only embedded fixtures or an explicitly supplied dataset are evaluated.
No deck data or agents are read. Offline analysis/calibration never calls models.`;

function integer(value, name, min, max) {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`--${name} must be ${min}..${max}`);
  return Number(value);
}

export function options(args) {
  const { values } = parseArgs({ args, options: {
    help: { type: "boolean" }, "dry-run": { type: "boolean" },
    "work-dir": { type: "string", default: "local-decision-test-data" },
    adapter: { type: "string", default: "legacy" }, models: { type: "string", default: "kai,julia" }, threads: { type: "string", default: "4" },
    repeat: { type: "string", default: "3" }, suite: { type: "string", default: "smoke" },
    "env-file": { type: "string", default: ".env.local" }, "jev-repeat": { type: "string", default: "1" },
    case: { type: "string" }, warmup: { type: "string", default: "1" }, timeout: { type: "string", default: "600" },
    dataset: { type: "string" }, split: { type: "string" }, policy: { type: "string" },
    "analyze-report": { type: "string" }, "calibrate-report": { type: "string" }, "evaluate-report": { type: "string" },
    "policy-out": { type: "string" }, "analysis-out": { type: "string" },
    "min-precision": { type: "string", default: ".98" }, "min-links": { type: "string", default: "10" },
  } });
  const models = values.models.split(","), threads = values.threads.split(",").map(v => integer(v, "threads", 1, 64));
  if (models.some(m => !Object.hasOwn(MODELS, m)) || new Set(models).size !== models.length) throw new Error(`--models accepts unique names: ${Object.keys(MODELS).join(",")}`);
  if (!["legacy", "concise"].includes(values.adapter)) throw new Error("--adapter must be legacy or concise");
  if (new Set(threads).size !== threads.length) throw new Error("Duplicate thread counts");
  if (!values["work-dir"].trim()) throw new Error("Empty --work-dir");
  const offline = ["analyze-report", "calibrate-report", "evaluate-report"].filter(k => values[k]);
  if (offline.length > 1 || (offline.length && (values.dataset || values.split || values["dry-run"]))) throw new Error("Choose one offline report operation or a dataset inference run");
  if (values["calibrate-report"] && !values["policy-out"]) throw new Error("--calibrate-report needs --policy-out");
  if (values["policy-out"] && !values["calibrate-report"]) throw new Error("--policy-out requires --calibrate-report");
  if (values["evaluate-report"] && !values.policy) throw new Error("--evaluate-report needs --policy");
  if (values.dataset && (!values.split || values.case || values.suite !== "smoke")) throw new Error("--dataset needs --split; --case and --suite stress are regression-only");
  if (values.split && (!values.dataset || !["calibration", "holdout"].includes(values.split))) throw new Error("--split calibration/holdout requires --dataset");
  if (values.policy && !values["evaluate-report"] && !(values.dataset && values.split === "holdout")) throw new Error("--policy is for held-out evaluation only");
  if (values.dataset && values.split === "holdout" && !values["dry-run"] && !values.policy) throw new Error("Freeze a policy before running live holdout inference");
  if (values.policy && !values["evaluate-report"] && (models.length !== 1 || threads.length !== 1)) throw new Error("Frozen-policy evaluation needs one model and one thread configuration");
  return { ...values, models, threads, repeat: integer(values.repeat, "repeat", 1, 5),
    jevRepeat: integer(values["jev-repeat"], "jev-repeat", 1, 5),
    warmup: integer(values.warmup, "warmup", 0, 3), timeout: integer(values.timeout, "timeout", 1, 7200), workDir: resolve(values["work-dir"]) };
}

export { command, installerCommand, runtimeEnvironment, bootstrap } from "./runtime-tools.mjs";
import { command, runtimeEnvironment, bootstrap } from "./runtime-tools.mjs";

async function assets() {
  return typeof __WORKER_SOURCE__ === "string" ? { worker: __WORKER_SOURCE__, downloader: __DOWNLOADER_SOURCE__ } : {
    worker: await readFile(join(here, "local_worker.py"), "utf8"), downloader: await readFile(join(here, "bundle_download.py"), "utf8") };
}

async function persist(report, directory) {
  for (const [name, content] of [["report.json", JSON.stringify(report, null, 2) + "\n"], ["report.html", renderReport(report)]]) {
    const temporary = join(directory, `${name}.tmp`);
    await writeFile(temporary, content); await rename(temporary, join(directory, name));
  }
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const opt = options(args);
  if (opt.help) { console.log(HELP); return 0; }
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24+ is required");
  if (opt["analyze-report"] || opt["calibrate-report"] || opt["evaluate-report"]) return offlineEvaluation(opt);
  const loaded = opt.dataset ? prepareDataset(opt.dataset === "synthetic-v1" ? SYNTHETIC_DATASET :
    JSON.parse(await readFile(opt.dataset, "utf8")), opt.split) : null;
  const prepared = loaded?.prepared ?? prepareSuite(opt.suite, opt.case);
  const promptVersion = opt.adapter === "concise" ? "chat_task_decision.concise.v3" : PROMPT_VERSION;
  const policy = opt.policy ? JSON.parse(await readFile(opt.policy, "utf8")) : null;
  if (policy) validatePolicy(policy, loaded.metadata, { model: opt.models[0], revision: MODELS[opt.models[0]].revision, prompt_version: promptVersion }, false);
  const jobs = prepared.filter(p => !p.skip).map(p => ({ case: p.fixture.id, request: portableRequest(p.payload, opt.adapter) }));
  if (opt["dry-run"]) {
    console.log(JSON.stringify({ mode: "offline plan", work_dir: opt.workDir, python: "3.13", models: opt.models.map(m => ({ name: m, ...MODELS[m], planned_inference_trials: jobs.length * (MODELS[m].cloud ? opt.jevRepeat : opt.repeat) })),
      threads: opt.threads, repeat: opt.repeat, suite: opt.suite, cases: prepared.length, inference_trials_per_run: jobs.length * opt.repeat,
      dataset_sha256: datasetHash(prepared), dataset: loaded?.metadata, prompt_version: promptVersion }, null, 2));
    return 0;
  }
  const started = new Date().toISOString(), directory = join(opt.workDir, "runs", `${started.replace(/[:.]/g, "-")}-${process.pid}`);
  await mkdir(directory, { recursive: true });
  const report = { schema_version: "portable_decision_eval.v1", started_at: started, status: "running",
    host: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length,
      total_ram_bytes: os.totalmem(), node: process.versions.node },
    prompt_version: promptVersion, dataset_sha256: datasetHash(prepared), suite: opt.suite, dataset: loaded?.metadata,
    thresholds: THRESHOLDS, context_threshold: CONTEXT_THRESHOLD, options: opt, fixtures: prepared.map(p => p.fixture), runs: [] };
  const packages = {}, exec = dependencies.command ?? command, env = runtimeEnvironment(opt.workDir);
  await writeFile(join(directory, "environment.json"), "{}\n"); await persist(report, directory);
  console.log(`Evidence: ${directory}`);
  let exitCode = 0;
  try {
    if (!["darwin", "win32", "linux"].includes(process.platform)) throw new Error("Supported operating systems: macOS, Windows, Linux");
    if (opt.models.some(m => !MODELS[m].cloud) && process.platform === "darwin" && process.arch === "x64") throw new Error("Current PyTorch has no native Intel macOS wheels; use Apple Silicon, Windows or Linux");
    const source = await assets(), harness = join(opt.workDir, ".harness", hash(source.worker + source.downloader).slice(0, 16));
    await mkdir(harness, { recursive: true });
    await writeFile(join(harness, "local_worker.py"), source.worker); await writeFile(join(harness, "bundle_download.py"), source.downloader);
    const locals = opt.models.filter(m => !MODELS[m].cloud);
    const uv = locals.length ? await (dependencies.bootstrap ?? bootstrap)(opt.workDir, env, join(directory, "setup.log"), exec) : null;
    if (uv) report.uv = await exec(uv, ["--version"], { env }); await persist(report, directory);
    for (const model of opt.models) {
      const spec = MODELS[model], modelDirectory = join(directory, model), venv = join(opt.workDir, ".venvs", model), python = pythonPath(venv);
      await mkdir(modelDirectory, { recursive: true });
      if (spec.cloud) {
        const entry = { model, revision: spec.revision, threads: null, status: "running" }; report.runs.push(entry);
        let raw = null, failure = null;
        try {
          if (!process.env.OPENROUTER_API_KEY && existsSync(opt["env-file"])) process.loadEnvFile(opt["env-file"]);
          if (!process.env.OPENROUTER_API_KEY?.trim()) throw new Error("OPENROUTER_API_KEY is missing; set it in the environment or --env-file");
          await writeFile(join(modelDirectory, "requests.json"), JSON.stringify({ model: spec.repo, jobs }, null, 2));
          raw = await (dependencies.runJev ?? runJev)(jobs, { apiKey: process.env.OPENROUTER_API_KEY, repeat: opt.jevRepeat,
            checkpoint: async value => { const path = join(modelDirectory, "raw.json"); await writeFile(path + ".tmp", JSON.stringify(value, null, 2)); await rename(path + ".tmp", path); } });
        } catch (error) { failure = error.message; }
        Object.assign(entry, scoreRun(raw, prepared, opt.jevRepeat, failure));
        if (entry.status !== "complete" || entry.summary.errors) exitCode = 2;
        else if (!entry.quality_passed) exitCode = Math.max(exitCode, 1);
        await persist(report, directory); continue;
      }
      const setupLog = join(modelDirectory, "setup.log"), common = { env, logPath: setupLog, timeout: 1800, echo: true };
      try {
        console.log(`\n[${model}] Preparing Python 3.13 and CPU dependencies`);
        try { await access(python); } catch { await exec(uv, ["venv", "--python", "3.13", "--managed-python", venv], common); }
        const cpuIndex = process.platform === "darwin" ? [] : ["--index-url", "https://download.pytorch.org/whl/cpu"];
        await exec(uv, ["pip", "install", "--python", python, spec.requirements[0], ...(spec.cpu_requirements ?? []), ...cpuIndex], common);
        await exec(uv, ["pip", "install", "--python", python, ...spec.requirements], common);
        packages[model] = { repo: spec.repo, revision: spec.revision, python: await exec(python, ["--version"], { env }),
          packages: await exec(uv, ["pip", "freeze", "--python", python], { env }) };
        await writeFile(join(directory, "environment.json"), JSON.stringify(packages, null, 2) + "\n");
        const downloadInput = join(modelDirectory, "download.json"), modelPath = join(opt.workDir, model);
        await writeFile(downloadInput, JSON.stringify({ model_id: spec.repo, revision: spec.revision, model_path: modelPath, exclude: spec.exclude, base: spec.base }));
        console.log(`[${model}] Downloading or verifying pinned checkpoint`);
        await exec(python, [join(harness, "bundle_download.py"), "--input", downloadInput], { ...common, logPath: join(modelDirectory, "download.log") });
        for (const threads of opt.threads) {
          const runDirectory = join(modelDirectory, `threads-${threads}`); await mkdir(runDirectory);
          const inputPath = join(runDirectory, "requests.json"), rawPath = join(runDirectory, "raw.json");
          await writeFile(inputPath, JSON.stringify({ model_id: spec.repo, model_path: modelPath, threads, repeat: opt.repeat, warmup: opt.warmup, jobs }, null, 2));
          const entry = { model, revision: spec.revision, threads, status: "running" }; report.runs.push(entry); await persist(report, directory);
          console.log(`[${model}] Evaluating ${jobs.length * opt.repeat} requests with ${threads} CPU threads`);
          let failure = null, raw = jobs.length ? null : { results: [] };
          if (jobs.length) {
            try { await exec(python, [join(harness, "local_worker.py"), "--input", inputPath, "--output", rawPath],
              { env: { ...env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }, logPath: join(runDirectory, "worker.log"), timeout: opt.timeout, echo: true }); }
            catch (error) { failure = error.message; }
            try { raw = JSON.parse(await readFile(rawPath, "utf8")); } catch { failure ??= "Missing worker checkpoint"; }
          }
          Object.assign(entry, scoreRun(raw, prepared, opt.repeat, failure));
          if (entry.status !== "complete" || entry.summary.errors) exitCode = 2;
          else if (!entry.quality_passed) exitCode = Math.max(exitCode, 1);
          await persist(report, directory);
          console.log(`[${model}] ${entry.status}; ${entry.summary.passed}/${entry.summary.trials} cases passed; ${entry.summary.errors} errors`);
        }
      } catch (error) {
        exitCode = 2;
        for (const threads of opt.threads.filter(t => !report.runs.some(r => r.model === model && r.threads === t))) report.runs.push({ model, revision: spec.revision, threads,
          ...scoreRun(null, prepared, opt.repeat, error.message), error: error.message });
        await persist(report, directory); console.error(`[${model}] ${error.message}; continuing to next model`);
      }
    }
  } catch (error) { report.error = error.message; exitCode = 2; }
  report.finished_at = new Date().toISOString();
  report.status = exitCode === 2 ? "incomplete or runtime errors" : exitCode === 1 ? "complete with quality failures" : "complete";
  if (policy) {
    report.baseline_exit_code = exitCode;
    try {
      report.frozen_policy = evaluatePolicy(report, policy);
      exitCode = report.frozen_policy.sample_target_met ? 0 : 1;
      report.status = exitCode ? "complete with frozen-policy target failure" : "complete";
      report.notes = ["The original policy remains a regression baseline in the run table. Independent diagnostics separate ranking, context and linking.",
        "For this held-out run, the exit code follows the frozen policy's sample targets. A passing sample does not guarantee representative or population accuracy."];
    }
    catch (error) { report.policy_error = error.message; exitCode = 2; report.status = "incomplete or runtime errors"; }
  }
  report.exit_code = exitCode; await persist(report, directory);
  console.log(`\nHTML report: ${join(directory, "report.html")}\nJSON report: ${join(directory, "report.json")}\nExit code: ${exitCode}`);
  return exitCode;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 2; });
}
