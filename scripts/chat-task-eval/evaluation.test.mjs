import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digest, prepareDataset, contextLabels, SYNTHETIC_DATASET } from "./dataset.mjs";
import { prepareSuite, datasetHash } from "./local.mjs";
import { portableRequest, scoreRun, MODELS } from "./benchmark-core.mjs";
import { analyzeReport, fitPolicy, evaluatePolicy, validatePolicy, renderAnalysis } from "./evaluation.mjs";
import { main, options } from "./benchmark.mjs";

function dataset() {
  const examples = [];
  for (const split of ["calibration", "holdout"]) for (let i = 0; i < 4; i++) {
    const f = structuredClone(prepareSuite("smoke")[0].fixture);
    f.id = `${split}-${i}`; f.group_id = f.id; f.split = split;
    f.payload.chat.id = f.id; f.payload.chat.title = `Release work ${split} ${i}`;
    f.payload.chat.latest_round.prompt = i < 2 ? `Prepare release ${split} ${i}.` : `Unrelated question ${split} ${i}.`;
    f.expected = { link_task_id: i < 2 ? "payments" : null, label: i < 2 ? "payments" : null, insufficient_context: i === 3 };
    examples.push(f);
  }
  return { schema_version: "decision_dataset.v1", name: "Synthetic test data", provenance: "synthetic", notes: "Unit-test fixtures, never representative validation", examples };
}

function response(prepared, iteration = 1, { winner = "payments", confidence = .96, context = .7 } = {}) {
  const tasks = prepared.payload.tasks, chosen = tasks.findIndex(t => t.id === winner), count = tasks.length + 1;
  const probabilities = Object.fromEntries([...tasks.map((t, i) => [`candidate_${i}`, i === chosen ? confidence : (1 - confidence) / (count - 1)]),
    ["no_match", chosen < 0 ? confidence : (1 - confidence) / (count - 1)]]);
  return { case: prepared.fixture.id, iteration, raw: { answers: { task: { type: "choice", probabilities },
    context: { type: "choice", probabilities: { sufficient: context, insufficient: 1 - context } } } } };
}

function report(document, split, repeat = 1) {
  const { prepared, metadata } = prepareDataset(document, split);
  const results = prepared.flatMap(p => Array.from({ length: repeat }, (_, i) => response(p, i + 1, {
    winner: p.fixture.expected.link_task_id ?? null, context: p.fixture.expected.insufficient_context ? .1 : .7 } )));
  return { status: "complete with quality failures", dataset_sha256: datasetHash(prepared), dataset: metadata,
    prompt_version: "chat_task_decision.concise.v3", fixtures: prepared.map(p => p.fixture), options: { repeat },
    runs: [{ model: "kai", revision: MODELS.kai.revision, threads: 4, ...scoreRun({ results }, prepared, repeat) }] };
}

test("regression annotations cover known context without changing fixture fingerprints", () => {
  const prepared = prepareSuite("smoke"), before = datasetHash(prepared), labels = contextLabels(prepared.map(p => p.fixture));
  assert.equal(Object.keys(labels).length, 23); assert.equal(labels["sparse-context"], true);
  assert.equal(labels["overlapping-tasks"], false); assert.equal(labels["no-matching-task"], false);
  assert.equal(datasetHash(prepared), before);
  assert.equal(before, "48e8e4fe59208341cb8063d40ab7d1bb31f9348341ea1ce8587bf3d3b04f3d04");
  const changed = structuredClone(prepared[0].fixture); changed.payload.chat.latest_round.prompt = "unlabelled";
  assert.deepEqual(contextLabels([changed]), {});
});

test("everyday synthetic set has balanced partitions and explicit, reviewable no-match labels", () => {
  const d = SYNTHETIC_DATASET;
  assert.equal(d.examples.length, 40);
  const families = new Map();
  for (const split of ["calibration", "holdout"]) {
    const { prepared } = prepareDataset(d, split);
    assert.equal(prepared.length, 20);
    const counts = Object.fromEntries(["match", "no_match", "ambiguous", "missing_context"].map(k =>
      [k, prepared.filter(p => p.fixture.kind === k).length]));
    assert.deepEqual(counts, { match: 8, no_match: 10, ambiguous: 1, missing_context: 1 });
    assert.ok(prepared.filter(p => p.fixture.category === "same-repository").length >= 4);
    assert.ok(prepared.some(p => p.fixture.category === "broad-task-scope"));
    for (const { fixture: f, payload, skip } of prepared) {
      assert.equal(skip, null); assert.ok(f.rationale.length > 30);
      assert.equal(f.expected.insufficient_context, f.kind === "missing_context");
      if (f.kind === "no_match") {
        assert.equal(f.expected.label, null); assert.equal(f.expected.link_task_id, null);
        assert.ok(payload.chat.latest_round.prompt.length > 60);
      } else if (f.kind !== "match") assert.ok(!Object.hasOwn(f.expected, "label"));
      assert.ok(!families.has(f.group_id) || families.get(f.group_id) === split);
      families.set(f.group_id, split);
      const request = JSON.stringify(portableRequest(payload, "concise"));
      for (const field of ["rationale", "expected", "group_id", "split", "kind", "category"])
        assert.ok(!request.includes(`"${field}":`));
    }
  }
  assert.equal(families.size, 8);
});

test("calibration tradeoffs expose useful matches versus errors without sweeping holdout", () => {
  const d = dataset(), r = report(d, "calibration"), { prepared } = prepareDataset(d, "calibration");
  r.runs[0].results[1] = response(prepared[1], 1, { confidence: .6 });
  r.runs[0].results[2] = response(prepared[2], 1, { winner: "portal", confidence: .55 });
  const analysis = analyzeReport(r), t = analysis.runs[0].calibration_tradeoffs;
  assert.deepEqual(t.points.map(p => [p.correct_cases, p.wrong_cases]), [[1, 0], [2, 1]]);
  const html = renderAnalysis(analysis);
  assert.match(html, /Wrong cases to correct/); assert.match(html, /2 \/ 2/);
  const p = fitPolicy(r, { minPrecision: .65, minLinks: 3 });
  assert.equal(p.calibration_metrics.correct_cases, 2); assert.equal(p.calibration_metrics.wrong_cases, 1);
  assert.equal(analyzeReport(report(d, "holdout")).runs[0].calibration_tradeoffs, undefined);
  const incomplete = structuredClone(r); incomplete.runs[0].results.pop();
  assert.match(analyzeReport(incomplete).runs[0].calibration_tradeoffs.unavailable, /every case/);
});

test("dataset rejects regression reuse, related groups/chats, duplicate evidence and invalid labels", () => {
  const mutate = change => { const d = dataset(); change(d); return () => prepareDataset(d, "calibration"); };
  assert.throws(mutate(d => { d.examples[0] = { ...prepareSuite("smoke")[0].fixture, group_id: "g", split: "calibration" }; }), /regression/);
  assert.throws(mutate(d => { d.examples[4].group_id = d.examples[0].group_id; }), /cross/);
  assert.throws(mutate(d => { d.examples[4].payload.chat.id = d.examples[0].payload.chat.id; }), /cross/);
  assert.throws(mutate(d => { d.examples[4].payload = structuredClone(d.examples[0].payload); d.examples[4].payload.chat.id = "different"; d.examples[4].payload.tasks.reverse(); }), /Duplicate evidence/);
  assert.throws(mutate(d => { delete d.examples[0].expected.insufficient_context; }), /labels/);
  assert.throws(mutate(d => { d.examples[0].expected.label = "portal"; }), /labels/);
  assert.throws(mutate(d => { d.examples[0].expected.insufficient_context = true; }), /labels/);
});

test("ranking, context errors and linking are measured independently; missing labels are unavailable", () => {
  const r = report(dataset(), "calibration"), m = analyzeReport(r).runs[0].metrics;
  assert.equal(m.ranking.accuracy, 1); assert.equal(m.linking.accepted_links, 0);
  assert.equal(m.context.sufficient_blocked, 3); assert.equal(m.context.missing_detected, 1);
  assert.equal(m.context_disabled.correct_links, 2); assert.equal(m.context_disabled.wrong_links, 0);
  const unknown = structuredClone(r); delete unknown.fixtures[0].expected.insufficient_context; unknown.dataset_sha256 = digest(unknown.fixtures);
  assert.equal(analyzeReport(unknown).runs[0].metrics.context.unlabelled_trials, 1);
  const invalidContext = structuredClone(r); delete invalidContext.runs[0].results[0].raw.answers.context;
  const separate = analyzeReport(invalidContext).runs[0].metrics;
  assert.equal(separate.ranking.valid_trials, 4); assert.equal(separate.context.invalid_trials, 1);
  assert.equal(separate.linking.expected_cases, 2); // Invalid context cannot erase an expected positive.
  const invalidTask = structuredClone(r); delete invalidTask.runs[0].results[0].raw.answers.task;
  assert.equal(analyzeReport(invalidTask).runs[0].metrics.context.valid_trials, 4);
  assert.equal(analyzeReport(invalidTask).runs[0].metrics.ranking.invalid_trials, 1);
});

test("calibration cannot use regression, incomplete inference, or repetitions as independent examples", () => {
  const r = report(dataset(), "calibration", 3);
  assert.throws(() => fitPolicy(r), /No policy/); // Six correct trials are only two accepted cases.
  const p = fitPolicy(r, { minPrecision: 1, minLinks: 2 });
  assert.equal(p.calibration_metrics.correct_cases, 2); assert.equal(p.calibration_metrics.correct_links, 6);
  assert.equal(p.thresholds.context, .65); assert.equal(p.thresholds.likelihood, .95);
  assert.match(p.qualification, /Synthetic/);
  const legacy = structuredClone(r); delete legacy.dataset;
  assert.throws(() => fitPolicy(legacy), /calibration dataset/);
  const incomplete = structuredClone(r); incomplete.runs[0].results.pop();
  assert.throws(() => fitPolicy(incomplete, { minLinks: 1 }), /repetitions/);
  const malformed = structuredClone(r); malformed.runs[0].results[0].raw.answers.context.probabilities.sufficient = 2;
  assert.throws(() => fitPolicy(malformed, { minLinks: 1 }), /valid inference/);
});

test("a wrong repetition counts against a case instead of being diluted by correct repeats", () => {
  const d = dataset(), r = report(d, "calibration", 3), { prepared } = prepareDataset(d, "calibration");
  r.runs[0].results[0] = response(prepared[0], 1, { winner: "portal" });
  assert.throws(() => fitPolicy(r, { minPrecision: 1, minLinks: 2 }), /No policy/);
});

test("held-out labels never influence selected thresholds and frozen identity/data must match", () => {
  const d = dataset(), calibration = report(d, "calibration"), p = fitPolicy(calibration, { minPrecision: 1, minLinks: 2 });
  const holdout = report(d, "holdout"), evaluated = evaluatePolicy(holdout, p);
  assert.equal(evaluated.sample_target_met, true); assert.equal(evaluated.metrics.correct_cases, 2);
  const html = renderAnalysis({ ...analyzeReport(holdout), frozen_policy: evaluated });
  assert.match(html, /2 \/ 2 genuine matches linked; 0 wrong links to correct/);
  assert.throws(() => evaluatePolicy(calibration, p), /holdout dataset/);
  const changed = structuredClone(holdout); changed.runs[0].revision = "wrong";
  assert.throws(() => evaluatePolicy(changed, p), /revision/);
  assert.throws(() => validatePolicy(p, { ...holdout.dataset, manifest_sha256: "changed" }, p.identity), /frozen/);
  const wrong = structuredClone(holdout); wrong.runs[0].results[0].raw = response(prepareDataset(d, "holdout").prepared[0], 1, { winner: "portal" }).raw;
  assert.equal(evaluatePolicy(wrong, p).sample_target_met, false);
  assert.deepEqual(evaluatePolicy(wrong, p).thresholds, p.thresholds);
});

test("offline analysis preserves sources; policy output cannot overwrite existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-evaluation-"));
  try {
    const input = join(root, "report.json"), output = join(root, "analysis"), policy = join(root, "policy.json");
    const contents = JSON.stringify(report(dataset(), "calibration")); await writeFile(input, contents);
    const noModel = { command: () => { throw Error("Unexpected model call"); }, bootstrap: () => { throw Error("Unexpected install"); } };
    assert.equal(await main(["--analyze-report", input, "--analysis-out", output], noModel), 0);
    assert.equal(await readFile(input, "utf8"), contents);
    assert.equal(await main(["--calibrate-report", input, "--policy-out", policy, "--min-links", "2", "--min-precision", "1"], noModel), 0);
    await assert.rejects(main(["--calibrate-report", input, "--policy-out", policy, "--min-links", "2"], noModel), /EEXIST/);
    assert.deepEqual((await readdir(output)).sort(), ["analysis.html", "analysis.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("custom dataset jobs exclude gold labels and live holdout requires a frozen policy", () => {
  const { prepared } = prepareDataset(dataset(), "calibration"), request = portableRequest(prepared[0].payload, "concise");
  assert.equal(request.expected, undefined); assert.equal(request.group_id, undefined); assert.equal(request.split, undefined);
  assert.throws(() => options(["--dataset", "data.json", "--split", "holdout"]), /Freeze/);
  assert.throws(() => options(["--dataset", "data.json", "--case", "one", "--split", "calibration"]), /regression-only/);
  assert.throws(() => options(["--analyze-report", "r.json", "--calibrate-report", "r.json"]), /one offline/);
});

test("live custom holdout evaluates only frozen holdout jobs and keeps the baseline separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-heldout-"));
  try {
    const d = dataset(), source = join(root, "dataset.json"), frozen = join(root, "policy.json");
    const policy = fitPolicy(report(d, "calibration"), { minLinks: 2, minPrecision: 1 });
    await writeFile(source, JSON.stringify(d)); await writeFile(frozen, JSON.stringify(policy));
    const heldout = prepareDataset(d, "holdout").prepared;
    const code = await main(["--dataset", source, "--split", "holdout", "--policy", frozen, "--models", "kai", "--adapter", "concise", "--repeat", "1", "--work-dir", join(root, "work")], {
      bootstrap: async () => "uv-mock",
      command: async (_exe, args) => {
        if (args[0]?.endsWith("local_worker.py")) {
          const config = JSON.parse(await readFile(args[2], "utf8"));
          assert.deepEqual(config.jobs.map(j => j.case), heldout.map(p => p.fixture.id));
          assert.ok(config.jobs.every(j => !JSON.stringify(j.request).includes('"expected"')));
          await writeFile(args[4], JSON.stringify({ results: heldout.map(p => response(p, 1, {
            winner: p.fixture.expected.link_task_id, context: p.fixture.expected.insufficient_context ? .1 : .7 })) }));
        }
        return "mock-version";
      },
    });
    assert.equal(code, 0);
    const runs = join(root, "work/runs"), dir = join(runs, (await readdir(runs))[0]);
    const result = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
    assert.equal(result.baseline_exit_code, 1); assert.equal(result.frozen_policy.sample_target_met, true);
    assert.equal(result.runs[0].summary.correct_auto_links, 0);
    assert.equal(result.frozen_policy.metrics.correct_cases, 2);
    assert.equal(result.dataset.split, "holdout");
  } finally { await rm(root, { recursive: true, force: true }); }
});
