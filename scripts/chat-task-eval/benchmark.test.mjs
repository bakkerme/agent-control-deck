import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { main, options, command, installerCommand, runtimeEnvironment } from "./benchmark.mjs";
import { scoreRun, renderReport, pythonPath, portableRequest, MODELS } from "./benchmark-core.mjs";
import { prepareSuite } from "./local.mjs";

test("portable options and platform paths support separate runtimes and reject ambiguous settings", () => {
  const opt = options([]);
  assert.deepEqual(opt.models, ["kai", "julia"]); assert.deepEqual(opt.threads, [4]); assert.equal(opt.repeat, 3);
  assert.notEqual(MODELS.kai.requirements[1], MODELS.julia.requirements[1]);
  assert.match(pythonPath("folder with spaces", "win32"), /Scripts\/python.exe$/);
  assert.match(pythonPath("folder with spaces", "linux"), /bin\/python$/);
  assert.deepEqual(installerCommand("folder with spaces/install.ps1", "win32"), ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "folder with spaces/install.ps1"]]);
  assert.deepEqual(installerCommand("x/install.sh", "darwin"), ["sh", ["x/install.sh"]]);
  for (const args of [["--models", "kai,kai"], ["--models", "toString"], ["--threads", "2,2"], ["--threads", "0"], ["--repeat", "6"]]) assert.throws(() => options(args));
});

test("runtime env confines caches and removes credentials and conflicting runtime overrides", () => {
  const env = runtimeEnvironment("work dir", { PATH: "system-path", SystemRoot: "Windows", OPENAI_API_KEY: "secret", HF_TOKEN: "secret", OPENROUTER_API_KEY: "secret", PYTHONPATH: "other", UV_INDEX: "other", PIP_INDEX_URL: "other" });
  assert.equal(env.PATH, "system-path"); assert.equal(env.SystemRoot, "Windows");
  for (const key of ["OPENAI_API_KEY", "HF_TOKEN", "OPENROUTER_API_KEY", "PYTHONPATH", "UV_INDEX", "PIP_INDEX_URL"]) assert.equal(env[key], undefined);
  assert.equal(env.CUDA_VISIBLE_DEVICES, ""); assert.equal(env.HF_HUB_DISABLE_IMPLICIT_TOKEN, "1");
  assert.equal(env.UV_PYTHON_INSTALL_DIR, join("work dir", ".python")); assert.equal(env.UV_NO_MODIFY_PATH, "1");
});

test("compact prompt retains evidence and never sends golden labels", () => {
  const prepared = prepareSuite("smoke", "ticket-over-repository")[0];
  const request = portableRequest(prepared.payload);
  assert.match(request.questions.task.criteria.candidate_0, /Tickets:/);
  assert.equal(request.expected, undefined); assert.equal(request.context, undefined);
  assert.deepEqual(Object.keys(request.questions.task.criteria), [...prepared.payload.tasks.map((_, i) => `candidate_${i}`), "no_match"]);
});

test("duplicate and missing trials cannot produce a complete or passing report", () => {
  const prepared = prepareSuite("smoke", "ticket-over-repository"), row = { case: prepared[0].fixture.id, iteration: 1, error: "failure", temperature: "warm", latency_ms: 12 };
  const result = scoreRun({ results: [row, row] }, prepared, 2);
  assert.equal(result.status, "incomplete"); assert.equal(result.quality_passed, false);
  assert.equal(result.summary.errors, 1); assert.equal(result.summary.unrun_trials, 1);
  assert.match(result.worker_error, /duplicate/);
  const missing = scoreRun(null, prepared, 3, "download failed");
  assert.equal(missing.summary.unrun_trials, 3); assert.equal(missing.summary.warm_latency_p50_ms, null);
});

test("HTML escapes model evidence and preserves unavailable metrics", () => {
  const report = { runs: [{ model: "<script>bad</script>", error: "<img src=x>", results: [] }], host: { platform: "linux", arch: "x64" }, thresholds: { likelihood: .9, margin: .2 } };
  const html = renderReport(report);
  assert.ok(!html.includes("<script>bad")); assert.ok(!html.includes("<img src=x>"));
  assert.ok(html.includes("&lt;script&gt;bad")); assert.ok(html.includes("—")); assert.ok(html.includes("report.json"));
});

test("one model setup failure still evaluates the other and writes final evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decision mock with spaces "));
  const calls = [];
  try {
    const code = await main(["--work-dir", directory, "--case", "ticket-over-repository", "--repeat", "1"], {
      bootstrap: async () => "uv-mock",
      command: async (executable, args) => {
        calls.push([executable, args]);
        if (args[0] === "venv" && args.at(-1).endsWith("kai")) throw new Error("Kai setup failure");
        if (args[0]?.endsWith("local_worker.py")) {
          const input = JSON.parse(await readFile(args[2], "utf8"));
          await writeFile(args[4], JSON.stringify({ results: input.jobs.map(j => ({ case: j.case, iteration: 1, error: "retained runtime failure" })) }));
        }
        return "mock-version";
      },
    });
    assert.equal(code, 2);
    const runName = (await readdir(join(directory, "runs")))[0], reportDirectory = join(directory, "runs", runName);
    const report = JSON.parse(await readFile(join(reportDirectory, "report.json"), "utf8"));
    assert.equal(report.runs.length, 2); assert.equal(report.runs[0].model, "kai"); assert.equal(report.runs[0].summary.unrun_trials, 1);
    assert.equal(report.runs[1].model, "julia"); assert.equal(report.runs[1].summary.errors, 1);
    assert.ok(calls.some(([, args]) => args[0]?.endsWith("bundle_download.py")));
    assert.ok((await readFile(join(reportDirectory, "report.html"), "utf8")).includes("Kai setup failure"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("worker command timeout preserves its log and returns a failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decision-timeout-")), logPath = join(directory, "worker.log");
  try {
    await assert.rejects(command(process.execPath, ["-e", "console.log('checkpoint evidence'); setInterval(()=>{},1000)"], { logPath, timeout: .2 }), /timeout/);
    assert.match(await readFile(logPath, "utf8"), /checkpoint evidence/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("built script runs offline from an empty folder without a checkout or node_modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decision standalone ")), bundle = join(directory, "local-decision-test.mjs");
  try {
    execFileSync(process.execPath, [resolve("scripts/chat-task-eval/build-local-bundle.mjs"), bundle]);
    const plan = JSON.parse(execFileSync(process.execPath, [bundle, "--dry-run"], { cwd: directory, encoding: "utf8" }));
    assert.equal(plan.cases, 23); assert.equal(plan.inference_trials_per_run, 60); assert.equal(plan.models.length, 2);
    assert.deepEqual(await readdir(directory), ["local-decision-test.mjs"]);
    assert.match(execFileSync(process.execPath, [bundle, "--help"], { cwd: directory, encoding: "utf8" }), /Node 24/);
    for (const split of ["calibration", "holdout"]) {
      const synthetic = JSON.parse(execFileSync(process.execPath, [bundle, "--dataset", "synthetic-v1", "--split", split,
        "--models", "kai", "--adapter", "concise", "--dry-run"], { cwd: directory, encoding: "utf8" }));
      assert.equal(synthetic.cases, 20); assert.equal(synthetic.dataset.split, split);
      assert.equal(synthetic.dataset.provenance, "synthetic");
      assert.equal(synthetic.dataset.calibration_cases, 20); assert.equal(synthetic.dataset.holdout_cases, 20);
    }
    assert.deepEqual(await readdir(directory), ["local-decision-test.mjs"]);
    await writeFile(join(directory, "dataset.json"), await readFile(resolve("scripts/chat-task-eval/dataset.example.json")));
    const custom = JSON.parse(execFileSync(process.execPath, [bundle, "--dataset", "dataset.json", "--split", "calibration", "--dry-run"], { cwd: directory, encoding: "utf8" }));
    assert.equal(custom.cases, 4); assert.equal(custom.dataset.split, "calibration");
    const p = prepareSuite("smoke", "ticket-over-repository");
    const cached = { status: "complete", dataset_sha256: (await import("./local.mjs")).datasetHash(p), fixtures: p.map(p => p.fixture),
      runs: [{ model: "kai", revision: MODELS.kai.revision, results: [{ case: p[0].fixture.id, iteration: 1, error: "retained failure" }] }] };
    await writeFile(join(directory, "cached.json"), JSON.stringify(cached));
    execFileSync(process.execPath, [bundle, "--analyze-report", "cached.json", "--analysis-out", "analysis"], { cwd: directory });
    assert.ok((await readFile(join(directory, "analysis/analysis.html"), "utf8")).includes("independent metrics"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Jev-only evaluation skips Python bootstrap and keeps credentials out of reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decision-cloud-"));
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "private-test-key";
  let repeat;
  try {
    const code = await main(["--models", "jev", "--work-dir", directory, "--case", "ticket-over-repository", "--adapter", "concise"], {
      bootstrap: async () => { throw new Error("Python must not run"); },
      command: async () => { throw new Error("No child process needed"); },
      runJev: async (jobs, options) => {
        assert.equal(options.apiKey, "private-test-key"); repeat = options.repeat;
        const raw = { runtime: { device: "remote" }, results: [{ case: jobs[0].case, iteration: 1, temperature: "remote", latency_ms: 50,
          raw: { answers: { task: { type: "choice", probabilities: { candidate_0: 0, candidate_1: 1, candidate_2: 0, no_match: 0 } },
            context: { type: "choice", probabilities: { sufficient: 1, insufficient: 0 } } }, usage: { cost: .001 } } }] };
        await options.checkpoint(raw); return raw;
      },
    });
    assert.equal(code, 0); assert.equal(repeat, 1);
    const reportDirectory = join(directory, "runs", (await readdir(join(directory, "runs")))[0]);
    const text = await readFile(join(reportDirectory, "report.json"), "utf8");
    assert.ok(!text.includes("private-test-key"));
    const report = JSON.parse(text);
    assert.equal(report.uv, undefined); assert.equal(report.prompt_version, "chat_task_decision.concise.v3");
    assert.equal(report.runs[0].summary.warm_latency_p50_ms, null);
    assert.equal(report.runs[0].summary.remote_latency_p50_ms, 50);
    assert.equal(report.runs[0].summary.reported_cost_usd, .001);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});


test("d3-edge is an explicit pinned addition with a separate runtime and unchanged suite", () => {
  const opt = options(["--models", "d3-edge", "--adapter", "legacy"]);
  assert.deepEqual(opt.models, ["d3-edge"]);
  assert.match(MODELS["d3-edge"].revision, /^[0-9a-f]{40}$/);
  assert.equal(MODELS["d3-edge"].requirements[1], "transformers==5.17.0");
  assert.ok(!MODELS["d3-edge"].requirements.some(r => /flash-linear-attention|causal-conv1d/.test(r)));
  assert.equal(prepareSuite("smoke").length, 23);
  const fixture = prepareSuite("smoke", "ticket-over-repository")[0];
  assert.deepEqual(portableRequest(fixture.payload, opt.adapter), portableRequest(fixture.payload));
});

test("j33-jev pins its own weights and config/tokenizer-only base assets separately from hosted Jev", () => {
  assert.deepEqual(options(["--models", "j33-jev"]).models, ["j33-jev"]);
  const spec = MODELS["j33-jev"];
  assert.match(spec.revision, /^[0-9a-f]{40}$/); assert.match(spec.base.revision, /^[0-9a-f]{40}$/);
  assert.equal(spec.base.repo, "google/embeddinggemma-2");
  assert.ok(spec.base.include.includes("config.json")); assert.ok(spec.base.include.includes("tokenizer.json"));
  assert.ok(!spec.base.include.some(p => /safetensors|\.bin$|\*/.test(p)));
  assert.deepEqual(spec.cpu_requirements, ["torchvision==0.29.1"]);
  assert.equal(spec.cloud, undefined); assert.equal(MODELS.jev.cloud, true);
});

test("crivo uses a pinned standalone CPU checkpoint without cloud or base downloads", () => {
  assert.deepEqual(options(["--models", "crivo-150m"]).models, ["crivo-150m"]);
  const spec = MODELS["crivo-150m"];
  assert.equal(spec.repo, "tardellirs/crivo-150m");
  assert.match(spec.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(spec.requirements, MODELS.kai.requirements);
  assert.equal(spec.base, undefined); assert.equal(spec.cloud, undefined);
});
