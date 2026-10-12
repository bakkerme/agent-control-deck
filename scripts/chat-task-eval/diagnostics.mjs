import { decide, THRESHOLDS } from "./matching.mjs";
import { distribution } from "./local.mjs";

export function policyDecision(row, policy) {
  return decide({ ...row.output, insufficient_context: row.raw.answers.context.probabilities.sufficient < policy.context }, policy);
}

export function linkMetrics(rows, policy, plannedCases = rows) {
  const valid = rows.filter(r => r.output && !r.error);
  const linked = valid.map(row => ({ row, decision: policyDecision(row, policy) })).filter(r => r.decision.action === "link");
  const correct = linked.filter(r => r.decision.task_id === r.row.expected.link_task_id).length;
  const grouped = Map.groupBy(valid, r => r.case), accepted = Map.groupBy(linked, r => r.row.case);
  // One case is one calibration unit. Any wrong repetition makes that accepted case wrong.
  const wrongCases = [...accepted.values()].filter(rs => rs.some(r => r.decision.task_id !== r.row.expected.link_task_id)).length;
  const planned = Map.groupBy(plannedCases.filter(r => r.decision?.action !== "skip"), r => r.case);
  const expectedCases = [...planned.values()].filter(rs => rs[0].expected?.link_task_id != null).length;
  const expectedTrials = rows.filter(r => r.decision?.action !== "skip" && r.expected?.link_task_id != null).length;
  return { trials: valid.length, accepted_links: linked.length, correct_links: correct, wrong_links: linked.length - correct,
    precision: linked.length ? correct / linked.length : null,
    recall: expectedTrials ? correct / expectedTrials : null,
    cases: planned.size, valid_cases: grouped.size, expected_cases: expectedCases, accepted_cases: accepted.size,
    correct_cases: accepted.size - wrongCases, wrong_cases: wrongCases,
    conservative_case_precision: accepted.size ? (accepted.size - wrongCases) / accepted.size : null,
    case_recall: expectedCases ? (accepted.size - wrongCases) / expectedCases : null };
}

export function diagnostics(rows, labels = {}, policy = { ...THRESHOLDS, context: .9 }, plannedCases = rows) {
  const inferred = rows.filter(r => r.decision?.action !== "skip");
  const separate = inferred.map(row => {
    const result = { ...row, task_valid: false, context_valid: false };
    try {
      const keys = row.payload.tasks.map((_, i) => `candidate_${i}`);
      const p = distribution(row.raw?.answers?.task, [...keys, "no_match"]);
      result.task_probabilities = [...row.payload.tasks.map((t, i) => ({ id: t.id, probability: p[keys[i]] })), { id: null, probability: p.no_match }];
      result.task_decision = decide({ task_likelihoods: row.payload.tasks.map((t, i) => ({ task_id: t.id, likelihood: p[keys[i]] })),
        no_match_likelihood: p.no_match, insufficient_context: false }, THRESHOLDS);
      result.task_valid = true;
    } catch { /* Keep the other question measurable. */ }
    try {
      result.context_score = distribution(row.raw?.answers?.context, ["sufficient", "insufficient"]).sufficient;
      result.context_valid = true;
    } catch { /* Keep the other question measurable. */ }
    return result;
  });
  const taskValid = separate.filter(r => r.task_valid), contextValid = separate.filter(r => r.context_valid);
  const labelled = taskValid.filter(r => Object.hasOwn(r.expected, "label"));
  const rankingCorrect = labelled.filter(r => r.task_decision.top_task_id === r.expected.label).length;
  const rankBrier = labelled.reduce((sum, r) => sum + r.task_probabilities.reduce((s, p) => s + (p.probability - (p.id === r.expected.label ? 1 : 0)) ** 2, 0), 0);
  const bins = [[0, .5], [.5, .7], [.7, .8], [.8, .9], [.9, 1]].map(([lower, upper]) => {
    const selected = labelled.filter(r => r.task_decision.likelihood >= lower && (upper === 1 ? r.task_decision.likelihood <= upper : r.task_decision.likelihood < upper));
    return { lower, upper, trials: selected.length, unique_cases: new Set(selected.map(r => r.case)).size,
      mean_score: selected.length ? selected.reduce((s, r) => s + r.task_decision.likelihood, 0) / selected.length : null,
      observed_accuracy: selected.length ? selected.filter(r => r.task_decision.top_task_id === r.expected.label).length / selected.length : null };
  });
  const confusion = { missing_detected: 0, missing_missed: 0, sufficient_blocked: 0, sufficient_allowed: 0 };
  let brier = 0, annotated = 0;
  const blockers = { valid_task_trials: taskValid.length, valid_context_trials: contextValid.length, context: 0, task_score: 0, margin: 0, no_match: 0 };
  for (const r of taskValid) {
    if (r.task_decision.likelihood < policy.likelihood) blockers.task_score++;
    if (r.task_decision.margin < policy.margin) blockers.margin++;
    if (r.task_decision.top_task_id === null) blockers.no_match++;
  }
  for (const r of contextValid) {
    const p = r.context_score;
    if (p < policy.context) blockers.context++;
    if (typeof labels[r.case] !== "boolean") continue;
    const missing = labels[r.case], blocked = p < policy.context;
    confusion[missing ? blocked ? "missing_detected" : "missing_missed" : blocked ? "sufficient_blocked" : "sufficient_allowed"]++;
    brier += (p - (missing ? 0 : 1)) ** 2; annotated++;
  }
  const missing = confusion.missing_detected + confusion.missing_missed;
  const sufficient = confusion.sufficient_allowed + confusion.sufficient_blocked;
  return { ranking: { labelled_trials: labelled.length, unique_cases: new Set(labelled.map(r => r.case)).size,
      valid_trials: taskValid.length, invalid_trials: inferred.length - taskValid.length,
      mean_brier: labelled.length ? rankBrier / labelled.length : null, confidence_bins: bins,
      correct_trials: rankingCorrect, accuracy: labelled.length ? rankingCorrect / labelled.length : null },
    context: { labelled_trials: annotated, unique_cases: new Set(contextValid.filter(r => typeof labels[r.case] === "boolean").map(r => r.case)).size,
      valid_trials: contextValid.length, invalid_trials: inferred.length - contextValid.length,
      unlabelled_trials: contextValid.length - annotated, ...confusion,
      missing_recall: missing ? confusion.missing_detected / missing : null,
      false_block_rate: sufficient ? confusion.sufficient_blocked / sufficient : null,
      brier: annotated ? brier / annotated : null },
    linking: linkMetrics(rows, policy, plannedCases), context_disabled: linkMetrics(rows, { ...policy, context: 0 }, plannedCases), blockers };
}
