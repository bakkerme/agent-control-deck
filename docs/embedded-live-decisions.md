# Native SDK decision acceptance and accounting recovery

On 2026-10-18, six additional scenarios passed through the actual Linux Electron window, production embedded adapter, Claude Agent SDK 0.3.302 and OpenRouter `deepseek/deepseek-v4.1-flash-1017`. These extend the [two-text batch](embedded-live-small-batch.md); they do not replace the prioritized [edge-case inventory](embedded-edge-cases.md). Native macOS/Windows, upstream provider failures, real context compaction and the entire inventory remain uncovered by these live runs.

| Scenario | Trigger and oracle | Evidence |
| --- | --- | --- |
| Read approval | Request a disposable synthetic file; click the actual Allow control; observe expected content acknowledgement and new model output; SDK exits. | [Read success](embedded-live-read-success-evidence.json) |
| Write denial | Request a synthetic target; click Deny; observe denial acknowledgement and assert target does not exist. | [Write/question](embedded-live-write-question-evidence.json) |
| AskUserQuestion | Answer A through the actual native UI; observe expected answer acknowledgement. | [Write/question](embedded-live-write-question-evidence.json) |
| Duplicate/reconnect | Send identical request ID concurrently; exactly one SDK query; replay after completion and renderer reload produces no new query. | [Final batch](embedded-live-final-decisions-evidence.json) |
| Backend restart/exact resume | Restart Electron with the same disposable database; replay accepted request gives zero queries; new turn recalls the synthetic marker and preserves the exact non-null SDK session ID. | [Final batch](embedded-live-final-decisions-evidence.json) |
| Cancel before effect | Tool starts a controlled child and reaches a ready barrier; click Cancel; SDK/tool/child exit, effect ledger remains empty, replay does not restart it. | [Final batch](embedded-live-final-decisions-evidence.json) |

All successful cases assert actual SDK processes exited. Independent outer guardian cleanup passed after each attempt. The guardian is a test cleanup owner, not production host isolation; [raw supervisor death remains unsupported](embedded-supervisor-boundary.md). Isolated test-only no-sandbox execution was expressly authorized, with private display/HOME/XDG and disposable synthetic data. Production sandbox defaults stay enabled. Credentials are backend-only runtime injection and are never recorded in these artifacts.

## Concrete defects and deterministic reproduction

The first Read attempt reached permission UI but its tool continuation was rejected by the test gate: the real SDK appends a system reminder after its user tool result. The gate now selects the final non-system message, retaining exact current tool-ID and query ownership checks. The [failed attempt](embedded-live-decisions-first-attempt.json) remains recorded. Only this read-only case was explicitly retried after fixing the gate. No uncertain write or completed successful scenario was retried.

A later provider accounting snapshot regressed from $0.003295428 to $0.002652030. Write denial and question/answer had passed, but the stale baseline caused financial reconciliation to stop before further cases. Admission now retains a monotonic accepted usage watermark and clips remaining balance accordingly. Original raw snapshots remain visible; a lower snapshot never restores spending capacity.

The provider's SSE cache fields did not satisfy the strict safe-integer validator. Their receipts remain `complete: false`; they are not relabeled complete in evidence. Progression required a separate positive provider account delta matching all forwarded numeric input/output/cache charges, with zero in-flight or incomplete HTTP responses. Accounting lag/mismatch stops the run. Fully observed counters are priced at conservative all-endpoint rates, rounded upward to a cent; the original records remain durable.

Reproduce the SDK continuation without inference or credentials:

```sh
npm run test:acceptance:prepare
python3 scripts/with-test-display.py node scripts/embedded-acceptance/guard.cjs \
  out-tests/app-acceptance.mjs --synthetic-wire --tool-flow-repro
```

`tests/acceptance-gateway.test.ts` covers trailing-system tool results, wrong IDs, malformed messages, interrupted/malformed/zero-input receipts and terminal event ordering. `tests/acceptance-admission.test.ts` covers stale accounting watermarks, insufficient caps, unknown fees, inherited/overlapping price overrides, exclusive durable reservations and missing/mismatched bill proofs. Run these through `npm test`; `npm run check` also runs renderer tests. These are injected/synthetic tests, not additional provider successes.

## Live limits, recovery and cost

Live execution is opt-in. The initial decisions command was:

```sh
ACD_EMBEDDED_PROVIDER=openrouter NODE_USE_ENV_PROXY=1 \
  python3 scripts/with-test-display.py --backend-env \
  node scripts/embedded-acceptance/guard.cjs out-tests/app-acceptance.mjs \
  --live --decisions
```

Recorded recovery stages were `--after-read-gate-fix`, `--remaining-after-read`, then `--finish-after-question` in addition to `--live --decisions`. They validate preserved predecessor summaries and matched bill evidence, skip completed cases and exclusively create separate durable reservation directories. They are audited recovery stages for this recorded experiment, not automatic retries. Existing reservation files make reruns fail closed. Do not delete, relocate or reset them to purchase another attempt. Future live work requires fresh authorization and reconciliation under the same shared cap.

Each case reserves two forwards at $0.80 each before dispatch, allows one request in flight, at most two SDK query starts, 512 output tokens, a 262,144-byte request, 45-second upstream timeout and no harness retry. Unexpected helper/retry requests consume the same cap. The coordinator has an eight-minute deadline and an independent cleanup owner. Live tool exposure is limited to the four tested tools; requested routing is DeepSeek-only/no-fallback, but admission bounds all listed endpoints independently of optional routing enforcement.

The old experiment's $16.25 envelope remains entirely retained because its per-attempt receipts are incomplete. It is a liability, not measured spend. The deliberately chosen $2 uncertainty margin was retained unchanged. Only newly matched, fully observed batches were reconciled to conservative cent-rounded liabilities; originals were never deleted. Before the final cancellation, maximum conservative commitment was **$19.984588524**, below the shared $20 cap. Final retained new liabilities are $0.13 for completed batches plus **the full $1.60 cancellation envelope**. The latest observed cumulative usage was $0.004588524, $0.003239892 above the original $0.001348632 baseline; it still lagged cancellation, so that delta is not the final cost. No additional inference is needed to repeat these successful cases.

Across the new two-text batch and these decision attempts, twelve inference forwards occurred: two initial texts, one failed Read gate attempt, two successful Read forwards, four Write/question forwards and three final forwards. Historical nine-case results remain separate. Numeric evidence excludes transcripts, credentials, private links, SDK session IDs and actual process IDs.

## Verification for this change

Local verification passed: commit guard 17/17; typecheck/build; backend 228 passed with one platform skip; browser renderer 27/27; native Electron 6 passed with one secure-storage skip. Focused admission/gateway regressions passed 20/20. Real-SDK synthetic text/cancel and tool-continuation reproductions passed without inference. Independent review found no scoped blocker. These synthetic and local checks are separate from the six live scenario outcomes above.
