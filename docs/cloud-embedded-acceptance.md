# Cloud embedded-agent acceptance

**Readiness: not ready for an orphan-free or crash-safe release claim.** Linux native Electron, deterministic storage faults and actual SDK process tests now run in the cloud, but a real active-tool backend-death reproduction leaves the SDK, Bash tool and its child running. This is a concrete process-containment blocker. No paid inference was dispatched during this acceptance pass; live admission is explicitly disabled in the coordinator until that blocker is resolved and reviewed. Earlier live results remain historical evidence only.

This supplements the prioritized [edge-case matrix](embedded-edge-cases.md). It does not establish Windows/WSL/macOS behavior, universal provider compatibility, exactly-once effects or bounded SDK memory.

## Reproduction commands and boundaries

Use Node 24 and the pinned dependencies (`npm ci`). Commands run from the repository root. Never supply real credentials to synthetic tests.

| Command | What it exercises | Requirement / cleanup |
| --- | --- | --- |
| `npm run check` | Commit artifact guard, TypeScript, actual SQLite/backend tests, browser renderer/runtime tests | No model calls or native windows. Browser tests need installed Chromium or Playwright browser; `ACD_TEST_CHROMIUM_PATH=/usr/bin/chromium` selects the cloud binary. |
| `npm run test:embedded:faults` | Controlled SDK messages/barriers, real SQLite fault triggers, independent flushed effect ledger, actual backend SIGKILL checkpoints | No model calls. Each test owns a temporary root/database; barriers and triggers are released during cleanup. |
| `npm run test:sdk:process` | Installed SDK 0.3.302 and actual local SDK child: cancellation, close and backend SIGKILL **while parked, before inference/tool dispatch** | Opt-in Linux `/proc` checks. Empty API key and isolated SDK configuration. Tracks exact children, bounded waits, own-PID cleanup. Does not prove active-tool cleanup. |
| `python3 scripts/with-test-display.py npm run test:electron` | Actual Electron main, preload, IPC and renderer; two embedded synthetic-SDK cases plus existing native smoke/titlebar/matching checks | Linux helper needs existing Xorg/dummy configuration, xauth, xprop and Xfwm. Uses cookie authentication, no TCP listener and temporary XDG roots. No installs/system changes. The helper alone enables test-only `--no-sandbox`; production flags remain unchanged. |
| `npm run test:acceptance:wire` | Real app/main/preload/IPC, production SDK adapter and actual SDK, synthetic Anthropic SSE upstream; ordinary text and controlled pre-effect cancellation | No provider calls. Separate test build aliases only the SDK boundary to a bounded wrapper around the real adapter. A real Bash tool starts a real child and waits at a filesystem barrier. Both must die before the coordinator releases that barrier; ledger stays empty. |
| `npm run repro:embedded:backend-death` | Real SDK/Bash/child, effect flushed before acknowledgement, backend SIGKILL | **Currently exits 1 by design of the oracle:** recorded live SDK/tool/descendant after 15-second exit deadline, one ledger effect, no tool-result acknowledgement. Finally kills only tracked PID/start-time identities and confirms exit/zombie. Never execute against a valuable cwd. |

The native synthetic-SDK tests use a disposable app bundle in `out-tests/native-app`; they never modify the production renderer/preload/main source for control access. Their fixture control is main-process-only, absent from the production bundle. Packaged-production smoke tests skip these two fixture cases explicitly. Browser tests are separate and do not count as Electron evidence.

SDK process exit checks accept a missing process or Linux zombie as no longer running. This container's PID 1 may leave exited children unreaped; a zombie is reported honestly and is not treated as a running orphan. PID/start-time comparisons prevent cleanup from killing a reused PID. No broad process-name kill is used.

## Concrete findings and regressions

| Finding | Before / trigger | Resulting behavior and evidence |
| --- | --- | --- |
| Approval released before its status write | Publish Write; abort the `waiting → running` UPDATE with a temporary SQLite trigger; allow it | Before fix, a forbidden filesystem effect occurred despite the command failing. Decision notice and status now commit in one transaction before resolving permission. Failed commit retains the waiter and produces zero effects. `decision status failure cannot authorize an effect before durable acknowledgement`. |
| Failed terminal persistence claimed success | Fail INSERT of `Turn complete`, then release successful SDK result | Before fix, chat became idle. Success is now assigned only after notice persistence; safe error is shown. `failed terminal persistence cannot claim successful idle completion`. |
| Persistent disk failure stranded cleanup | Fail every event INSERT/status UPDATE with two pending requests, then cancel | Waiters settle denied without writing in their resolution callback; cleanup cannot be bypassed by a failed state write. Volatile error reports incomplete durable history; further sends reject until restart/repair. `persistent disk failures during cancellation settle every waiter and release ownership`; `failed permission publication denies safely and does not leave a hidden waiter`. These faults are test-only, not provider events. |
| Cancellation exposed an exact SDK session before child exit | Hold an explicit process-exit barrier after close/cancel and send again | Previously a second writer was admitted. The production adapter tracks the actual child exit, and normal cleanup retains ownership until exit. A 10-second watchdog reports unknown shutdown without unlocking. `cancel retains exact-session ownership until tracked process exit`. This guarantee is local-process/observed-exit based; custom remote spawners must provide exit semantics. |
| SDK automatic title generation adds an unexpected inference | Synthetic-wire gate observed title-generation request before the intended prompt, using the same query header | Pass the existing Deck chat name through the SDK's documented `Options.title`; this skips automatic title inference for new sessions. Regression asserts the selected title; wire test proves only the intended request is forwarded. This does not claim all helper/compaction requests are disabled. |
| **Active tool survives backend SIGKILL (open blocker)** | Real SDK approves `node <temporary effect sink> post`; sink flushes one effect, starts a child and publishes readiness; SIGKILL Electron backend | After 15 seconds, SDK/tool/child all reported live (`S`). Parked SDK tests pass, so EOF before inference is insufficient evidence. Coordinator records uncertainty and kills its own tracked processes. `repro:embedded:backend-death`; summary `crashObservation`. A separately designed supervisor/platform containment mechanism is needed; app JavaScript cannot run after SIGKILL. |

No cancellation test promises rollback of an already approved in-flight external effect. The post-effect crash oracle preserves the one known ledger entry and missing acknowledgement. The application send ledger deduplicates an existing send ID; a fresh ID or resumed provider conversation is not an effect-idempotency guarantee. Do not automatically retry uncertain effects.

## Bounded live foundation — disabled pending containment

`run.ts` refuses `--live` **before** accounting, SDK startup or provider dispatch. Removing that block requires a reviewed containment fix and budget-owner admission. There is no scheduled task, automatic retry or CI paid test.

The prepared backend-only coordinator and [gateway](../scripts/embedded-acceptance/gateway.ts) provide:

- One coordinator; current cumulative key accounting, existing shared US$20 ceiling and US$2 uncertainty headroom. The historical reservation must be reconciled with terminated old processes and current accounting before a new batch, never inferred from an SDK cost estimate. Reservations remain charged after errors/cancellation.
- Pinned main/helper route `deepseek/deepseek-v4.1-flash-1017`. Catalog pricing is checked against a US$0.80 worst-full-context plus maximum-completion reservation **per actual forwarded request**, before forwarding; model, query count, request count, body and output limits are also enforced at the local gate.
- At most 9 queries, 16 forwards, 2 forwards per query, 2 SDK turns, 2,048 output tokens per forward, 262,144-byte request, 45-second forward, 8-minute coordinator and 10-minute gate deadline. SDK budget is secondary, not the spending oracle. No model fallback, title helper or retry is assumed free.
- A second query request requires a fully received successful SSE `message_stop` with `tool_use`, and actual results matching tool IDs from that response. Exact duplicate bodies, changed-body retries after end-turn, retired queries and excess requests reject before dispatch. Transport failure, non-success, client disconnect or incomplete stream closes admission globally. Expected cancellation retires the query before SDK cancellation.
- Only numeric usage/accounting and sanitized outcomes are recorded, never raw prompts/transcripts, credentials, actual session IDs or private links. The key remains in backend memory. A token authenticates the loopback gate; test main-process control is not exposed through preload.

The fake-wire unit tests cover malformed/primitive/oversized inputs, wrong route/token, concurrency with a controlled barrier, expiry with a controlled clock, exhausted budget, output clamp, reservations, tool continuations, query retirement and fail-closed errors. They do not establish provider billing behavior. The live case list remains a prepared plan, not executed coverage.

## Remaining acceptance work

P0: contain the actual SDK and active tool tree across backend death; prove no old writer survives restart before resuming a session. Repeat the committed-effect/no-ack test without promising rollback. Assess spawned descendants that detach or escape a process group, and native Windows job/WSL lifetime boundaries separately.

P1: authorize a new bounded live batch only after that fix, then verify isolated tasks/exact resume after restart, Read allow, Write deny with no file, questions, cancellation, routing and accounting. Preserve the original shared cap; prior live coverage must not be relabeled as this pass.

Other matrix gaps remain: malformed event permutations and subagent root identity, stale/missing resume IDs, storage loss during session association, native multi-window trust/subframe rejection, moved/replaced cwd at approval time, schema upgrades, huge producer queues/backpressure and partial credential-fragment redaction. Native Mac/Windows/WSL coverage is not supplied by Linux/Xorg, and this fixture bundle is not packaged release verification.

## Recorded cloud results (2026-10-18)

Environment: Linux x64, Node 24.19, Electron 44.5.1, SDK 0.3.302. Experimental base `9d8cddd` includes PRs 18, 19 and 20; no main merge or unrelated fixture fix was copied.

| Execution | Actual outcome |
| --- | --- |
| `npm run check` with clean environment and installed Chromium | Artifact guard 17 passed; typecheck/build passed; backend 202 passed, 1 Windows-only skip; renderer 27 passed. |
| Focused deterministic regressions | 18 embedded-fault cases and 9 gateway cases passed (included in backend count). Initial new decision-status and terminal-write cases failed against the prior behavior, then passed after fixes; exit-ownership case likewise failed before its fix. |
| Native Electron/Xorg suite | 6 passed, 1 skipped because secure-storage support is unavailable. Includes 2 new embedded fixture cases using real preload/IPC. This is Linux native testing with test-only no-sandbox, not packaged Mac/Windows verification. |
| Real parked SDK process suite | 3 passed: cancel, close, backend death; no inference submitted. |
| Real SDK + synthetic wire | 2 passed: intended text request and pre-effect Bash cancellation with child exit and zero effects. 2 synthetic forwards; no paid upstream. |
| Real SDK active-tool crash repro | Expected oracle failure: after backend SIGKILL, SDK `S`, tool `S`, descendant `S` after 15 seconds; 1 committed ledger effect. Coordinator cleanup confirmed no tracked live processes. A preceding text case passed; 2 synthetic forwards, no paid upstream. |
| Independent review | Read-only review identified retry admission/body-disconnect hardening and missing SDK cleanup tracking; addressed and rereviewed. Reviewer agreed the active-tool crash remains a release/live blocker. |
| Paid acceptance | **Not run; US$0 new inference spend.** Coordinator rejects `--live` before dispatch. No current provider accounting is claimed from synthetic counters. |

The coordinator writes sanitized runtime summaries under ignored `test-results/wire-acceptance-summary.json` and `test-results/wire-crash-summary.json`; they contain no session IDs, raw provider events, actual PIDs or credentials. Reproduction commands regenerate them. Linux PID observations establish the bounded observation period, not an assertion that every possible descendant is controlled.
