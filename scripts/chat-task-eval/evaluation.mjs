import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { prepareInput, decide, THRESHOLDS } from "./matching.mjs";
import { adaptOutput } from "./local.mjs";
import { digest, contextLabels } from "./dataset.mjs";
import { diagnostics, linkMetrics } from "./diagnostics.mjs";

const BASELINE = { ...THRESHOLDS, context: .9 };
export function scoredRows(report, run) {
  if (report.status === "running" || !Array.isArray(report.fixtures) || digest(report.fixtures) !== report.dataset_sha256)
    throw new Error("Report needs finished status and intact fixture fingerprint");
  const fixtures = new Map(report.fixtures.map(f => [f.id, f])), seen = new Set();
  if (fixtures.size !== report.fixtures.length) throw new Error("Duplicate report fixtures");
  return run.results.map(row => {
    const fixture = fixtures.get(row.case), key = JSON.stringify([row.case, row.iteration]);
    if (!fixture || seen.has(key) || !Number.isInteger(row.iteration) || row.iteration < 1) throw new Error("Unknown or duplicate report trial");
    seen.add(key);
    const input = prepareInput(fixture.payload, fixture.context ?? {});
    if (input.skip) return { ...row, output: undefined, decision: { action: "skip" } };
    const base = { ...row, payload: input.payload, expected: fixture.expected, output: undefined };
    if (row.error) return base;
    try {
      const output = adaptOutput(row.raw, input.payload);
      return { ...base, output, decision: decide(output, THRESHOLDS) };
    } catch (error) { return { ...base, error: error.message }; }
  });
}

export function identity(report, run) {
  const actual = [...new Set(run.results.flatMap(r => r.raw?.model ? [r.raw.model] : []))];
  if (actual.length > 1) throw new Error("Model identity changed within the source run");
  return { model: run.model, revision: run.revision, prompt_version: run.prompt_version ?? report.prompt_version,
    actual_model: actual[0] ?? null };
}

export function analyzeReport(report) {
  return { schema_version: "decision_analysis.v1", created_at: new Date().toISOString(),
    dataset_sha256: report.dataset_sha256, dataset: report.dataset ?? { split: "regression", provenance: "synthetic" },
    notes: ["Baseline thresholds remain 0.90 task, 0.20 margin, 0.90 context. Context-disabled results are an ablation, not a deployment policy.",
      "Regression context annotations are separate from the original fixtures and apply only to exact known fixtures. Unknown labels remain unavailable.",
      "Trial counts include repetitions; unique cases are reported separately. Repetitions are not independent labelled examples."],
    runs: report.runs.map(run => {
      const rows = scoredRows(report, run), planned = report.fixtures.filter(f => !prepareInput(f.payload, f.context ?? {}).skip)
        .map(f => ({ case: f.id, expected: f.expected }));
      let tradeoffs;
      if (report.dataset?.split === "calibration") {
        try { tradeoffs = calibrationTradeoffs(partitionReport({ ...report, runs: [run] }, "calibration").rows); }
        catch (error) { tradeoffs = { unavailable: error.message }; }
      }
      return { ...identity(report, run), threads: run.threads, status: run.status, calibration_tradeoffs: tradeoffs,
        errors: rows.filter(r => r.error).length, unrun_trials: run.summary?.unrun_trials,
        metrics: diagnostics(rows, contextLabels(report.fixtures), BASELINE, planned) };
    }) };
}

function partitionReport(report, split) {
  const data = report.dataset;
  if (data?.split !== split || !["synthetic", "anonymized-work"].includes(data.provenance) ||
      !/^[a-f0-9]{64}$/.test(data.manifest_sha256 ?? "") ||
      report.dataset_sha256 !== data[`${split}_sha256`] ||
      report.fixtures?.some(f => f.split !== split || typeof f.expected?.insufficient_context !== "boolean"))
    throw new Error(`Requires a complete explicitly labelled ${split} dataset report; regression results cannot be used`);
  if (report.runs?.length !== 1) throw new Error("Select exactly one model/thread configuration per policy");
  const run = report.runs[0], rows = scoredRows(report, run);
  if (run.status !== "complete" || run.worker_error || run.error || rows.some(r => !r.output || r.error) ||
      new Set(rows.map(r => r.case)).size !== report.fixtures.length || run.summary?.unrun_trials || run.summary?.errors)
    throw new Error("Calibration and holdout require complete, valid inference for every case");
  const repeat = report.options?.[run.model === "jev" ? "jevRepeat" : "repeat"];
  if (!Number.isInteger(repeat) || rows.length !== report.fixtures.length * repeat ||
      rows.some(r => r.iteration > repeat)) throw new Error("Dataset report has incomplete repetitions");
  return { data, run, rows };
}

const GRID = [0, .25, .5, .65, .75, .8, .85, .9, .95, .98, .99, 1];
function policyCandidates(rows) {
  // Precompute ranks; candidate selection counts each case once and penalizes any wrong repetition.
  const groups = [...Map.groupBy(rows, r => r.case).values()];
  const candidates = [];
  for (const likelihood of GRID) for (const margin of [0, .1, .2, .3, .4, .5]) for (const context of GRID) {
    let accepted = 0, wrong = 0;
    for (const group of groups) {
      const links = group.filter(r => r.decision.top_task_id !== null && r.decision.likelihood + Number.EPSILON >= likelihood &&
        r.decision.margin + Number.EPSILON >= margin && r.raw.answers.context.probabilities.sufficient >= context);
      if (links.length) {
        accepted++;
        if (links.some(r => r.decision.top_task_id !== r.expected.link_task_id)) wrong++;
      }
    }
    const precision = accepted ? (accepted - wrong) / accepted : null, correct = accepted - wrong;
    candidates.push({ thresholds: { likelihood, margin, context }, accepted, wrong, correct, precision });
  }
  return candidates;
}

// Calibration diagnostics show the useful-links/corrections tradeoff without imposing a release target.
// Keep one conservative threshold representative for each non-dominated outcome.
export function calibrationTradeoffs(rows) {
  const outcomes = new Map();
  for (const candidate of policyCandidates(rows)) {
    const key = `${candidate.correct}:${candidate.wrong}`;
    outcomes.set(key, candidate); // Grid order prefers higher thresholds for identical outcomes.
  }
  const all = [...outcomes.values()];
  const points = all.filter(c => !all.some(other => other.correct >= c.correct && other.wrong <= c.wrong &&
    (other.correct > c.correct || other.wrong < c.wrong))).sort((a, b) => a.wrong - b.wrong || b.correct - a.correct);
  return { expected_cases: new Set(rows.filter(r => r.expected.link_task_id !== null).map(r => r.case)).size,
    points: points.map(c => ({ thresholds: c.thresholds, correct_cases: c.correct, wrong_cases: c.wrong,
      accepted_cases: c.accepted, conservative_case_precision: c.precision })),
    note: "Calibration only. Compare useful matches gained with corrections introduced. Choose thresholds before viewing held-out answers; no zero-error shipping requirement." };
}

export function fitPolicy(report, { minPrecision = .98, minLinks = 10 } = {}) {
  if (!(minPrecision > 0 && minPrecision <= 1) || !Number.isInteger(minLinks) || minLinks < 1)
    throw new Error("Minimum precision must be >0..1; minimum accepted cases must be a positive integer");
  const { data, run, rows } = partitionReport(report, "calibration");
  if (!report.fixtures.some(f => f.expected.link_task_id === null) ||
      !report.fixtures.some(f => f.expected.link_task_id !== null) ||
      !report.fixtures.some(f => f.expected.insufficient_context) ||
      !report.fixtures.some(f => !f.expected.insufficient_context))
    throw new Error("Calibration needs positive links, abstentions, missing context and sufficient context examples");
  let best = null;
  for (const { thresholds, accepted, precision, correct } of policyCandidates(rows)) {
    if (accepted < minLinks || precision < minPrecision) continue;
    const { likelihood, margin, context } = thresholds;
    const score = [correct, precision, likelihood, margin, context];
    const different = best ? score.findIndex((v, i) => v !== best.score[i]) : -1;
    if (!best || (different !== -1 && score[different] > best.score[different]))
      best = { thresholds: { likelihood, margin, context }, score };
  }
  if (!best) throw new Error("No policy meets calibration targets; inspect calibration tradeoffs before choosing another experiment target");
  return { schema_version: "decision_policy.v1", created_at: new Date().toISOString(), identity: identity(report, run),
    dataset: data, calibration_report_sha256: digest(report), targets: { min_precision: minPrecision, min_accepted_cases: minLinks },
    thresholds: best.thresholds, calibration_metrics: linkMetrics(rows, best.thresholds),
    qualification: data.provenance === "synthetic" ? "Synthetic calibration only; representative work accuracy remains unknown" : "Calibration sample only; held-out evaluation required",
    grid: { likelihood: GRID, margin: [0, .1, .2, .3, .4, .5], context: GRID } };
}

export function validatePolicy(policy, dataset, modelIdentity, includeActual = true) {
  if (policy?.schema_version !== "decision_policy.v1" || !policy.identity || !policy.thresholds ||
      ["model", "revision", "prompt_version"].some(k => typeof policy.identity[k] !== "string" || !policy.identity[k].trim()) ||
      ["likelihood", "margin", "context"].some(k => typeof policy.thresholds[k] !== "number" || !Number.isFinite(policy.thresholds[k]) || policy.thresholds[k] < 0 || policy.thresholds[k] > 1) ||
      !(typeof policy.targets?.min_precision === "number" && policy.targets.min_precision > 0 && policy.targets.min_precision <= 1) ||
      !Number.isInteger(policy.targets?.min_accepted_cases) || policy.targets.min_accepted_cases < 1)
    throw new Error("Invalid frozen calibration policy");
  if (dataset?.split !== "holdout" || policy.dataset?.manifest_sha256 !== dataset.manifest_sha256 ||
      policy.dataset?.holdout_sha256 !== dataset.holdout_sha256 || policy.dataset?.calibration_sha256 !== dataset.calibration_sha256)
    throw new Error("Policy requires its frozen held-out partition from the same dataset manifest");
  for (const k of ["model", "revision", "prompt_version", ...(includeActual ? ["actual_model"] : [])])
    if (policy.identity[k] !== modelIdentity[k]) throw new Error(`Policy ${k} differs from evaluation configuration`);
}

export function evaluatePolicy(report, policy) {
  const { data, run, rows } = partitionReport(report, "holdout");
  validatePolicy(policy, data, identity(report, run));
  const metrics = linkMetrics(rows, policy.thresholds);
  return { thresholds: policy.thresholds, targets: policy.targets, metrics,
    sample_target_met: metrics.accepted_cases >= policy.targets.min_accepted_cases && metrics.conservative_case_precision >= policy.targets.min_precision,
    qualification: data.provenance === "synthetic" ? "Synthetic held-out sample; representative work accuracy remains unknown" : "Held-out sample result; no population reliability guarantee" };
}

const escape = value => String(value ?? "—").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const percent = value => value === null || value === undefined ? "—" : `${(100 * value).toFixed(1)}%`;
export function renderAnalysis(report) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Decision evaluation: independent metrics</title>
  <style>body{font:15px/1.5 system-ui;margin:32px;color:#182235;background:#f7f9fc;max-width:1700px}table{border-collapse:collapse;background:white;width:100%;font-size:13px}td,th{padding:10px;text-align:left;border-bottom:1px solid #dce3ed}th{background:#eaf0f8}.scroll{overflow:auto}details{padding:14px;background:white;margin:18px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
  <h1>Decision evaluation: independent metrics</h1><p>${escape(report.dataset.split)} · ${escape(report.dataset.provenance)} · ${escape(report.dataset_sha256)}</p>
  ${report.notes.map(n => `<p>${escape(n)}</p>`).join("")}
  <div class="scroll"><table><thead><tr><th>Model / adapter</th><th>Rank accuracy</th><th>Labelled rank cases</th><th>Labelled context cases</th><th>Missing context detected</th><th>Sufficient context falsely blocked</th><th>Baseline: correct / expected cases; wrong</th><th>Context disabled: correct / expected cases; wrong</th><th>Errors / unrun</th></tr></thead><tbody>
  ${report.runs.map(r => { const m = r.metrics; return `<tr><td>${escape(r.model)}<br>${escape(r.prompt_version)}</td><td>${percent(m.ranking.accuracy)}</td><td>${m.ranking.unique_cases}</td><td>${m.context.unique_cases}</td><td>${percent(m.context.missing_recall)}</td><td>${percent(m.context.false_block_rate)}</td><td>${m.linking.correct_cases} / ${m.linking.expected_cases}; ${m.linking.wrong_cases} wrong</td><td>${m.context_disabled.correct_cases} / ${m.context_disabled.expected_cases}; ${m.context_disabled.wrong_cases} wrong</td><td>${escape(r.errors)} / ${escape(r.unrun_trials)}</td></tr>`; }).join("")}</tbody></table></div>
  <p>Link columns count distinct cases; any wrong repetition makes that accepted case wrong. Trial counts and confidence bins are in the details. Gate blocker counts overlap: one request can fail several gates. Errors and unrun trials are retained.</p>
  ${report.runs.map(r => `<details><summary>${escape(r.model)} · ${escape(r.prompt_version)} · errors ${escape(r.errors)} · unrun ${escape(r.unrun_trials)}</summary><pre>${escape(JSON.stringify(r.metrics, null, 2))}</pre></details>`).join("")}
  ${report.runs.filter(r => r.calibration_tradeoffs).map(r => {
    const t = r.calibration_tradeoffs;
    if (t.unavailable) return `<p>Calibration tradeoffs unavailable: ${escape(t.unavailable)}</p>`;
    return `<h2>${escape(r.model)}: calibration tradeoffs</h2><p>${escape(t.note)}</p><div class="scroll"><table><thead><tr><th>Correct / expected cases</th><th>Wrong cases to correct</th><th>Task score threshold</th><th>Margin threshold</th><th>Context threshold</th><th>Accepted-link precision</th></tr></thead><tbody>${t.points.map(p => `<tr><td>${p.correct_cases} / ${t.expected_cases}</td><td>${p.wrong_cases}</td><td>${p.thresholds.likelihood}</td><td>${p.thresholds.margin}</td><td>${p.thresholds.context}</td><td>${percent(p.conservative_case_precision)}</td></tr>`).join("")}</tbody></table></div>`;
  }).join("")}
  ${report.frozen_policy ? `<h2>Frozen policy on held-out data</h2><p>${report.frozen_policy.metrics.correct_cases} / ${report.frozen_policy.metrics.expected_cases} genuine matches linked; ${report.frozen_policy.metrics.wrong_cases} wrong links to correct. ${escape(report.frozen_policy.qualification)}</p><details><summary>Frozen thresholds and full metrics</summary><pre>${escape(JSON.stringify(report.frozen_policy, null, 2))}</pre></details>` : ""}<p><a href="analysis.json">Full analysis JSON</a></p></html>`;
}

export async function offlineEvaluation(opt) {
  const input = opt["analyze-report"] ?? opt["calibrate-report"] ?? opt["evaluate-report"];
  const report = JSON.parse(await readFile(input, "utf8"));
  if (opt["calibrate-report"]) {
    const policy = fitPolicy(report, { minPrecision: Number(opt["min-precision"]), minLinks: Number(opt["min-links"]) });
    await mkdir(dirname(resolve(opt["policy-out"])), { recursive: true });
    await writeFile(opt["policy-out"], JSON.stringify(policy, null, 2) + "\n", { flag: "wx" });
    console.log(`Frozen policy: ${resolve(opt["policy-out"])}\n${policy.qualification}`);
    return 0;
  }
  const analysis = analyzeReport(report);
  analysis.source_report = { path: resolve(input), sha256: digest(report) };
  if (opt["evaluate-report"]) analysis.frozen_policy = evaluatePolicy(report, JSON.parse(await readFile(opt.policy, "utf8")));
  const directory = resolve(opt["analysis-out"] ?? `test-results/decision-analysis/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "analysis.json"), JSON.stringify(analysis, null, 2) + "\n", { flag: "wx" });
  await writeFile(resolve(directory, "analysis.html"), renderAnalysis(analysis), { flag: "wx" });
  console.log(`Independent analysis: ${resolve(directory, "analysis.html")}`);
  return opt["evaluate-report"] && !analysis.frozen_policy.sample_target_met ? 1 : 0;
}
