# Cloud embedded-agent acceptance

**Readiness: Linux backend-death containment now passes the original active-tool reproduction; general product crash containment remains unverified.** A per-run Linux subreaper/pidfd supervisor fixes the observed SDK/Bash/child survival after backend SIGKILL. Supervisor SIGKILL remains an explicit tested limit: the SDK root dies, but an already adopted tool can survive. macOS/Windows/WSL containment is not implemented or established here. No paid inference was dispatched; the coordinator still requires separate budget-owner admission.

This supplements the prioritized [edge-case matrix](embedded-edge-cases.md). It does not establish Windows/WSL/macOS behavior, universal provider compatibility, exactly-once effects or bounded SDK memory.

## Reproduction commands and boundaries

Use Node 24 and the pinned dependencies (`npm ci`). Linux builds/tests now also require a C11 compiler (`cc`) and a kernel permitting unprivileged `pidfd_open` (Linux 5.3+) and per-process subreaper setup; unavailable containment fails before SDK exec, with no direct-spawn fallback. Build the helper on its target OS/architecture. Commands run from the repository root. Never supply real credentials to synthetic tests.

| Command | What it exercises | Requirement / cleanup |
| --- | --- | --- |
| `npm run check` | Commit artifact guard, TypeScript, actual SQLite/backend tests, browser renderer/runtime tests | No model calls or native windows. Browser tests need installed Chromium or Playwright browser; `ACD_TEST_CHROMIUM_PATH=/usr/bin/chromium` selects the cloud binary. |
| `npm run test:embedded:faults` | Controlled SDK messages/barriers, real SQLite fault triggers, independent flushed effect ledger, actual backend SIGKILL checkpoints | No model calls. Each test owns a temporary root/database; barriers and triggers are released during cleanup. |
| `npm run test:sdk:process` | Installed SDK 0.3.302 and actual local SDK child: cancellation, close and backend SIGKILL **while parked, before inference/tool dispatch** | Opt-in Linux `/proc` checks. Empty API key and isolated SDK configuration. Tracks exact children, bounded waits, own-PID cleanup. Does not prove active-tool cleanup. |
| `python3 scripts/with-test-display.py npm run test:electron` | Actual Electron main, preload, IPC and renderer; two embedded synthetic-SDK cases plus existing native smoke/titlebar/matching checks | Linux helper needs existing Xorg/dummy configuration, xauth, xprop and Xfwm. Uses cookie authentication, no TCP listener and temporary XDG roots. No installs/system changes. The helper alone enables test-only `--no-sandbox`; production flags remain unchanged. |
| `npm run test:acceptance:wire` | Real app/main/preload/IPC, production SDK adapter and actual SDK, synthetic Anthropic SSE upstream; ordinary text and controlled pre-effect cancellation | No provider calls. Separate test build aliases only the SDK boundary to a bounded wrapper around the real adapter. A real Bash tool starts a real child and waits at a filesystem barrier. Both must die before the coordinator releases that barrier; ledger stays empty. |
| `npm run repro:embedded:backend-death` | Real SDK/Bash/child, effect flushed before acknowledgement, backend SIGKILL | **Now passes on Linux:** the same pre-fix failure oracle verifies supervisor/SDK/tool/child exit, one retained committed effect, interruption notice and same-send deduplication after restart. Finally kills only tracked PID/start-time identities and confirms exit/zombie. Never execute against a valuable cwd. |

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
| **Active tool survived backend SIGKILL (fixed for tested Linux boundary)** | Real SDK approves `node <temporary effect sink> post`; sink flushes one effect, starts a child and publishes readiness; SIGKILL Electron backend | Before the supervisor, SDK/tool/child all remained live (`S`) after 15 seconds. The same actual SDK reproduction now passes with per-run Linux subreaping and exact-backend pidfd watch. One committed effect remains; no acknowledgement is fabricated or send replayed. Parked SDK EOF alone was insufficient evidence. Supervisor/host death and other platforms remain separate boundaries. |

No cancellation test promises rollback of an already approved in-flight external effect. The post-effect crash oracle preserves the one known ledger entry and missing acknowledgement. The application send ledger deduplicates an existing send ID; a fresh ID or resumed provider conversation is not an effect-idempotency guarantee. Do not automatically retry uncertain effects.

## Bounded live foundation — held for separate budget admission

`run.ts` refuses `--live` **before** accounting, SDK startup or provider dispatch. Removing that block requires final containment review and separate budget-owner admission. The tested Linux backend-death failure is fixed; this does not authorize paid calls. There is no scheduled task, automatic retry or CI paid test.

The prepared backend-only coordinator and [gateway](../scripts/embedded-acceptance/gateway.ts) provide:

- One coordinator; current cumulative key accounting, existing shared US$20 ceiling and US$2 uncertainty headroom. The historical reservation must be reconciled with terminated old processes and current accounting before a new batch, never inferred from an SDK cost estimate. Reservations remain charged after errors/cancellation.
- Pinned main/helper route `deepseek/deepseek-v4.1-flash-1017`. Catalog pricing is checked against a US$0.80 worst-full-context plus maximum-completion reservation **per actual forwarded request**, before forwarding; model, query count, request count, body and output limits are also enforced at the local gate.
- At most 9 queries, 16 forwards, 2 forwards per query, 2 SDK turns, 2,048 output tokens per forward, 262,144-byte request, 45-second forward, 8-minute coordinator and 10-minute gate deadline. SDK budget is secondary, not the spending oracle. No model fallback, title helper or retry is assumed free.
- A second query request requires a fully received successful SSE `message_stop` with `tool_use`, and actual results matching tool IDs from that response. Exact duplicate bodies, changed-body retries after end-turn, retired queries and excess requests reject before dispatch. Transport failure, non-success, client disconnect or incomplete stream closes admission globally. Expected cancellation retires the query before SDK cancellation.
- Only numeric usage/accounting and sanitized outcomes are recorded, never raw prompts/transcripts, credentials, actual session IDs or private links. The key remains in backend memory. A token authenticates the loopback gate; test main-process control is not exposed through preload.

The fake-wire unit tests cover malformed/primitive/oversized inputs, wrong route/token, concurrency with a controlled barrier, expiry with a controlled clock, exhausted budget, output clamp, reservations, tool continuations, query retirement and fail-closed errors. They do not establish provider billing behavior. The live case list remains a prepared plan, not executed coverage.

## Remaining acceptance work

P0: macOS/Windows/WSL need their own containment design and actual native acceptance. Linux backend death, detached/double-fork adoption and root-exit cleanup pass; killing the supervisor itself can leave a tool alive and is explicitly outside that guarantee. No scheme promises to undo completed writes, survive host/kernel loss or kill uninterruptible kernel work.

P1: authorize a new bounded live batch only after that fix, then verify isolated tasks/exact resume after restart, Read allow, Write deny with no file, questions, cancellation, routing and accounting. Preserve the original shared cap; prior live coverage must not be relabeled as this pass.

Other matrix gaps remain: malformed event permutations and subagent root identity, stale/missing resume IDs, storage loss during session association, native multi-window ownership and subframe IPC rejection (untrusted top-level renderer rejection passed), moved/replaced cwd at approval time, schema upgrades, huge producer queues/backpressure and partial credential-fragment redaction. Native Mac/Windows/WSL coverage is not supplied by Linux/Xorg, and this fixture bundle is not packaged release verification.

## Recorded cloud results (2026-10-18)

Environment: Linux x64, Node 24.19, Electron 44.5.1, SDK 0.3.302. Experimental base `9d8cddd` includes PRs 18, 19 and 20; no main merge or unrelated fixture fix was copied.

| Execution | Actual outcome |
| --- | --- |
| `npm run check` with clean environment and installed Chromium | Artifact guard 17 passed; typecheck/build passed; backend 216 passed, 1 platform skip; renderer 27 passed. |
| Focused deterministic regressions | 20 embedded-fault cases, 9 gateway cases and 12 supervisor/integrity cases passed (included in backend count). Initial new decision-status and terminal-write cases failed against the prior behavior, then passed after fixes; exit-ownership case likewise failed before its fix. |
| Native Electron/Xorg suite | 6 passed, 1 skipped because secure-storage support is unavailable. Includes 2 new embedded fixture cases using real preload/IPC. This is Linux native testing with test-only no-sandbox, not packaged Mac/Windows verification. |
| Real parked SDK process suite | 3 passed: cancel, close, backend death; no inference submitted. |
| Real SDK + synthetic wire | 2 passed: intended text request and pre-effect Bash cancellation with child exit and zero effects. 2 synthetic forwards; no paid upstream. |
| Real SDK active-tool crash repro | Before fix: SDK/tool/descendant remained `S` after 15 seconds. After fix: text + same post-effect backend-SIGKILL/restart oracle passed; SDK/tool/child exited, exactly 1 committed effect retained and old send deduplicated. 2 synthetic forwards; no paid upstream. |
| Independent review | Read-only review identified retry admission/body-disconnect hardening and missing SDK cleanup tracking; addressed and rereviewed. Native-supervisor review also caught SIGPIPE, owner-identity and process-name parsing races; each was fixed with focused coverage. Supervisor death and other platforms remain documented limits. |
| Paid acceptance | **Not run; US$0 new inference spend.** Coordinator rejects `--live` before dispatch. No current provider accounting is claimed from synthetic counters. |

The coordinator writes sanitized runtime summaries under ignored `test-results/wire-acceptance-summary.json` and `test-results/wire-crash-summary.json`; they contain no session IDs, raw provider events, actual PIDs or credentials. Reproduction commands regenerate them. Linux PID observations establish the bounded observation period, not an assertion that every possible descendant is controlled.

## Supervisor-death follow-up

See [the bounded failure-model investigation and cloud admission decision](embedded-supervisor-boundary.md). It fixes the real SDK force-kill escalation path and adds an independent outer test guardian. Controlled two-failure cleanup passes without labeling product containment successful. Live remains held for the explicit budget-owner admission described there.

## Linux supervisor boundary

The packaged helper is compiled from `src/main/sdk-supervisor.c`. Before forking the SDK it validates the backend identity, opens a pidfd for that exact PID, rechecks the parent and sets itself as a subreaper. SDK protocol descriptors remain direct; backend lifetime and numeric startup reporting use separate descriptors, closed before SDK exec. EOF, backend pidfd readiness, SIGTERM/INT/HUP and SDK-root exit converge on killing/reaping only direct children owned by this supervisor. Orphaned descendants are adopted even after setsid/double-fork; cleanup repeats until `waitpid` reports no children. There are no system-wide settings, privileged operations or process-name kills. A per-SDK parent-death signal terminates the SDK root if its supervisor dies.

The helper does not rely on the optional `/proc/<pid>/task/<tid>/children` interface (absent on this cloud kernel). It reads complete bounded stat records and checks its own unreaped children by PPID; their PIDs cannot be reused before it reaps them. SDK processes with newline/parenthesis names are covered. Startup owner/pipe/report errors fail closed; fault checkpoints exist only in separately compiled test binaries, absent from production.

Production verifies the helper's binary digest, source fingerprint compiled into the app, protocol version and app version before launch. The adjacent manifest detects corrupt/stale/mismatched build artifacts; it is not an authenticity boundary against an attacker who can replace the app. The helper and manifest are unpacked together for packaged execution. Linux smoke initializes the real SDK through that packaged helper without inference.

Explicit supervisor-SIGKILL testing confirms a residual boundary: the SDK root is terminated by its parent-death signal, but an already adopted detached tool can survive. The test records this limitation and terminates its own fixture. The UI warns that tools may survive app/host failures and asks users to verify uncertain effects before sending again. No claim extends Linux evidence to macOS, Windows, WSL, hostile tools targeting their supervisor or host failures.

Bugbot identified that a proven failed local spawn was being treated as an uncertain exit/storage failure. Failed Node spawns without a PID now release the exit fence normally, leaving the ordinary connection error and allowing an explicit new attempt. A regression covers this separately from supervisor-signal death, which reports uncertain process cleanup and locks further sends.

Linux packaged verification passed: 4 native production smoke cases, with 2 synthetic-SDK fixture cases intentionally skipped and 1 unavailable secure-storage skip. The official SDK initialized through the actual unpacked supervisor with executable-mode and digest checks, without inference. The ordinary package command hit this managed environment's unwritable `/home/agent/.electron-gyp` rebuild cache. Local verification then used the already validated installed SQLite N-API prebuild and Electron distribution:

```sh
ELECTRON_BUILDER_CACHE=/tmp/acd-electron-builder-cache node_modules/.bin/electron-builder --dir --config.npmRebuild=false --config.electronDist=node_modules/electron/dist
python3 scripts/with-test-display.py npm run test:packaged
```

These are local validation overrides; no production/default rebuild, download, sandbox or signing setting was changed. CI uses the ordinary target-OS packaging command.
