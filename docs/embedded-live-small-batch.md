# Guarded native live acceptance: two-query batch

On 2026-10-18 the actual Linux native Electron app, production adapter and installed Claude Agent SDK completed two OpenRouter text queries using `deepseek/deepseek-v4.1-flash-1017`. Both returned the expected acknowledgement, produced a new assistant/model observation and exited their SDK process trees. The tasks received distinct SDK session IDs. The gate forwarded exactly two requests, with no rejection or incomplete response; independent outer-guardian cleanup passed. [Sanitized numeric evidence](embedded-live-small-batch-evidence.json) contains no transcript, credentials, session IDs or actual PIDs.

This is a small native live acceptance pass, not fresh coverage of resume, permission tools, cancellation, provider failures, incremental renderer streaming or the entire edge-case matrix. Historical nine-case live results and current synthetic fault results remain distinct. The product supervisor-death limitation in [the failure-model report](embedded-supervisor-boundary.md) remains unsupported; the outer guardian is a test cleanup owner, not host-managed isolation or a production guarantee.

## Admission and accounting

The owner authorized isolated test-only no-sandbox native acceptance with existing proxy-authenticated runtime access. Production defaults remain unchanged. The installed Xorg helper provides a private cookie-authenticated display without TCP, temporary HOME/XDG directories and disposable synthetic task data. Only the coordinator forwards to fixed accounting/catalog/model endpoint URLs and the fixed inference route. Credentials stay in backend memory; no unrelated browsing or credential provisioning is required.

`admission.ts` fetches fresh key accounting, current model pricing and every model endpoint's pricing. It fails closed on missing/invalid bounds, unknown nonzero fees, unsupported pricing or insufficient remaining budget. It conservatively adds cache/reasoning fees, includes fixed per-request fees, checks every time override and never subtracts discounts. DeepSeek's full context/full completion bound was $0.792723456. Every listed endpoint's full context plus the independently enforced 512 output-token limit was at most $0.528457728. Both fit the $0.80 reserve. Optional DeepSeek-only/no-fallback/max-price routing is requested, but its enforcement/provider identity is not independently established; budgeting does not depend on it.

Prior completed-run evidence was reconciled without releasing its conservative envelopes: the entire historical $16 plus separate $0.25 smoke reserve remain retained. Fresh recorded usage was $0.001348632. This batch reserved 2 × $0.80 = $1.60 plus $2 uncertainty headroom before the first request. Total conservative commitment was **$19.851348632**, below the shared $20 aggregate cap. The record is exclusively created (`wx`), file-fsynced and parent-directory-fsynced at ignored `test-results/live-budget-reservation.json`. It remains after every outcome and blocks another coordinator/rerun. No request-level or SDK estimate releases money.

Immediate post-run usage remained $0.001348632 / remaining $19.998651368. This can lag: **new spend is not claimed to be zero**. A later read at 22:56:43 UTC showed cumulative usage $0.001513032 / remaining $19.998486968, an observed cumulative increase of $0.000164400. This is an accounting snapshot, not a reason to release reservations. Keep the full $1.60 reservation and all earlier reserves. No further inference is admitted by this work.

## Reproduction

With explicit live authorization and backend runtime injection already supplied, prepare and run:

```sh
npm run test:acceptance:prepare
ACD_EMBEDDED_PROVIDER=openrouter NODE_USE_ENV_PROXY=1 \
  python3 scripts/with-test-display.py --backend-env \
  node scripts/embedded-acceptance/guard.cjs out-tests/app-acceptance.mjs \
  --live --small-batch
```

The completed batch's reservation already exists in this workspace, so rerunning fails closed before inference. Do not delete or relocate it to bypass admission. A future batch requires reconciliation and a revised durable ledger/policy under the same shared cap; it is not automatically authorized by this command.

Live is restricted to this two-text-query mode. Fault/crash modes remain synthetic. Every actual upstream request, including unexpected SDK helpers/retries, consumes the two-forward limit before dispatch. Changed-body retries of completed/failed/retired queries are denied; only a verified completed tool continuation is eligible in the reusable synthetic gate. The live forward removes tool/plugin/model-fallback/route extensions and requests no tools. Limits: 512 output tokens, 262,144-byte body, one upstream request in flight, 45-second upstream timeout, eight-minute coordinator deadline, and no harness retry. Unexpected output/model/tool behavior fails rather than purchasing another attempt. Whole-batch reservations survive timeout, cancellation and process loss.

Numeric accounting requests are non-inference reads. Tests inject accounting/pricing failures without contacting the provider. Synthetic guardian fixtures use private directories so their failure summaries do not overwrite acceptance evidence.
