# Supervisor failure boundary and cloud acceptance decision

The remaining raw-supervisor-death case is a **product limitation**, but it does not require an absolute arbitrary-process guarantee before running controlled cloud acceptance. A separate test-owned subreaper can clean the isolated test tree when the product supervisor and backend fail. This does not make the product generally crash-contained.

Investigation also found a normal-use defect: SDK 0.3.302's installed `ProcessTransport.close` waits about two seconds, sends SIGTERM and schedules SIGKILL five seconds later if its process still appears alive. The process is our containment supervisor. Slow cleanup could therefore destroy the owner while tools remained. The Linux SDK-facing adapter now translates its SIGKILL/string or signal 9 into the supervisor's SIGTERM cleanup request. Other platforms/custom spawners are unchanged. Raw OS `process.kill(pid, 'SIGKILL')` still exercises the real unsupported boundary.

## Failure model and oracles

| Failure | Product behavior / evidence | Cloud test policy |
| --- | --- | --- |
| One backend crashes or is SIGKILLed; supervisor and kernel remain healthy | Supervisor's exact-backend pidfd triggers owned-child kill/adoption/reaping, including detached/double-forked children. Actual SDK/Bash/child reproduction passes. One committed effect remains; restart shows interruption and does not replay accepted send. | Supported tested Linux boundary. An outer test guardian remains a fallback; its cleanup never counts as product success. |
| Normal cancel, SDK root exit or SDK-requested escalation during slow cleanup | SDK-facing force-kill is routed to supervisor cleanup. A controlled SIGSTOP barrier queues SIGTERM and SIGKILL requests while owner remains alive; SIGCONT releases it and children are reaped. Backend ownership remains until definitive exit; existing watchdog/fault tests report unknown shutdown and reject another turn. | Supported control path. No promise of a fixed shutdown time for uninterruptible kernel work. |
| Product supervisor is externally SIGKILLed/OOM-killed while backend lives | Kernel parent-death signal stops SDK root; an already adopted tool can remain alive. Backend reports process-cleanup uncertainty and rejects a fresh send. This is distinct from a proven failed spawn, which has no child and does not lock the chat. | Test this deliberately with a separate outer guardian. Record product non-containment, then verify test cleanup. Do not interpret an outer cleanup as a product fix. |
| Product supervisor and backend die together | Product alone cannot clean every reparented tool after both owners disappear. No automatic resend or rollback is promised. | External test guardian owns the whole coordinator/app tree, adopts these tools and reaps them when coordinator exits. Actual SDK synthetic-wire test passes this cleanup oracle with one effect before/after. |
| Test coordinator or runner dies | Outer subreaper observes its root or owner pidfd; controlled test descendants are adopted/cleaned independently of the coordinator's JS `finally`. | Keep the outer guardian alive; retain all admitted cost reservations. A killed outer guardian is a failed/unconfirmed test, never a success. |
| Outer guardian also receives SIGKILL, severe OOM, host/kernel loss | No user-space cleanup owner can promise execution after it is killed. Full host/WSL shutdown normally removes local processes, but external effects and already-dispatched provider requests may have completed or remain billable. Partial guest failure requires host-side observation. | Excluded from the current process-safety gate; retain worst-case spend reservations and uncertain effects. Do not infer WSL behavior from Linux fixtures. |
| Tool deliberately attacks its supervisor, invokes unrelated system services/containers or creates external work | Same-user process ownership is not a security sandbox. Subreaping covers descendant adoption, not external services or a hostile tool killing all owners. | Only fixed synthetic commands in disposable directories are admitted. Arbitrary escaping tools and platform service/job designs require separate work. |

This is a failure-containment model for controlled local tools, not protection from malicious same-user code, fork bombs, privileged children, every possible process state or remote side effects.

## External test guardian

`scripts/embedded-acceptance/guard.cjs` is a test runner, absent from the production app. It verifies the native helper/source/version/digest, then uses a separate subreaper instance to own the **entire** acceptance coordinator. The SDK can only address its inner product supervisor; SDK escalation cannot target this outer owner. The test runner sends only cleanup requests to the outer guardian and never force-kills it merely to satisfy a timeout.

For the two-failure case, the real SDK requests the controlled Bash effect, the coordinator observes its flushed ledger and child readiness, kills the inner supervisor, checks the product's uncertain state and rejected fresh send, then kills the backend. It records the still-live tool, does not perform its ordinary PID cleanup, and exits. The outer guardian adopts/reaps the remaining tree. Only after the outer guardian exits does the runner verify recorded PID/start-time identities are gone and the ledger remains exactly one. Required evidence cannot be missing/empty; negative fixtures prove those cases fail.

```sh
npm run test:acceptance:wire
npm run repro:embedded:backend-death
npm run test:acceptance:supervisor-boundary
```

All three run through the outer guardian, use the actual installed SDK with a synthetic SSE upstream, and make no paid calls. The final command records `documented-unsupported-product-boundary`, not product containment success. Its sanitized outer summary is `test-results/outer-acceptance-summary.json`; raw identities remain temporary test-owned evidence. Unconfirmed outer cleanup retains its private recovery report rather than erasing it.

## Unprivileged options assessed in this cloud environment

The existing Linux subreaper + pidfd setup works without privileges, persistent configuration, global settings or changes to Electron's production sandbox. No additional permission is needed for the controlled test setup above. Linux needs the existing C compiler and a kernel allowing these per-process syscalls.

Stronger host-enforced containment is unavailable to this task: the cgroup v2 mount is read-only and not writable/delegated; the user systemd manager reports offline; an unprivileged user/PID namespace probe fails because `/proc/self/uid_map` is read-only. No attempt was made to change mount flags, sysctls, capabilities, helper permissions, services or distro state.

If acceptance must include independent test-guardian death, the concrete platform setup needed is a disposable host-managed container/VM or delegated per-test cgroup/PID namespace with an **outside** owner that can kill and observe the entire test workload. That requires platform provisioning/delegation, not merely another in-process timeout. Production macOS/Windows/WSL containment also needs its own native design and acceptance; this PR does not redesign those platforms.

## Paid admission decision

**Process-safety decision:** selected controlled Linux acceptance cases can run behind the tested outer guardian while explicitly excluding outer-owner/host failure and hostile tools. The raw product-supervisor limitation alone no longer justifies a blanket hold on such an isolated test. The SDK escalation defect had to be fixed first; it now is.

**Paid execution is still held, not silently enabled.** Both the coordinator and outer runner reject `--live`. The single budget owner must complete and record this admission before enabling selected calls:

1. Choose the exact controlled cases and acknowledge the failure model above. Do not admit arbitrary commands or cross-platform crash claims.
2. Obtain fresh backend-only cumulative accounting and remaining key budget; reconcile all earlier shared-budget reservations. Prior historical usage or synthetic counters are not a current balance. No credential inspection/copying/provisioning is required.
3. Verify the pinned route's current complete worst-case pricing, including any fixed/additional fees; fail closed if the US$0.80 per-request reserve is insufficient or unsupported charge components appear. Existing prepared token/context arithmetic alone is not a provider bill.
4. Reserve the **whole batch maximum before launch** in the budget owner's durable record, retaining it after any process failure. The prepared maximum is 16 actual forwards × US$0.80 + US$2 uncertainty headroom = US$14.80, which must fit within the remaining shared US$20 cap after prior work. A smaller selected batch should reserve its explicit maximum. Do not release reservations from SDK estimates or lagging accounting.
5. Retain the existing gate's route/query/request/output/body/deadline bounds, fail-closed transport/retry behavior, zero automatic replay, and outer-guardian cleanup evidence. Stop the batch on unexpected tools, process uncertainty or admission failure.

This task made no paid calls, changed no credentials and did not claim those financial preflights have just passed. The remaining action is a concrete budget-owner admission for a narrow guarded batch, not permission for global/kernel/security changes or a claim of general product readiness.

## Recorded follow-up results

On the PR21 cloud Linux environment, the required check completed with 17 guard tests, typecheck/build and 27 browser passes. After the final evidence-validation additions, the backend suite was rerun: **221 passed, 1 platform skip**. Native Electron repeated with **6 passed, 1 unavailable secure-storage skip**.

All three actual-SDK/synthetic-wire runs passed behind the external guardian: pre-effect cancellation, committed-effect/backend SIGKILL/restart with no replay, and raw supervisor-plus-backend death with explicitly unsupported product containment followed by confirmed external cleanup. Each run forwarded only two synthetic responses and dispatched no paid inference. The two-failure ledger was one before and one after outer cleanup; a fresh send was rejected while product cleanup was uncertain.

The held-cleanup SDK-escalation regression passed without waiting for the real seven-second timer: it exercises the actual SDK-facing signal sequence at a controlled process-stop barrier. Four negative coordinator fixtures prove missing, empty, invalid-birth and duplicate-PID evidence cannot pass. A separate missing-helper setup check invalidated an existing passing summary before dispatch. Independent review identified these evidence gaps; they were addressed before commit.
