# Embedded conversation experiment

18 October 2026. This is a focused foundation on `experiment/embedded-claude-chat`, based on `origin/main` at `edac3f0`. The historical product outline is preserved separately as `product-outline-2026-10.md`; its larger document-review proposals are outside this slice.

## Try it

Use Node 24+ and npm. Install with `npm ci` (including optional dependencies), build with `npm run build`, and launch with the experiment enabled. For an isolated trial on macOS/Linux:

```sh
ACD_EMBEDDED_CHAT=1 ./node_modules/.bin/electron . --data-dir=/tmp/agent-control-deck-embedded-trial
```

On Windows PowerShell, set `$env:ACD_EMBEDDED_CHAT='1'`, then run `npx electron . --data-dir=C:\Temp\agent-control-deck-embedded-trial` after building. Windows/WSL execution has not been verified on this branch; the working directory must be a local folder for the host running Electron. Existing WSL/tmux hook monitoring remains available.

Create or select a task in Today. Under **Conversation · Experimental**, choose **New embedded chat**, supply a name and an absolute local working directory, then send a message. Each chat has its own SDK session even when several tasks share a directory. The task's existing linked-chat controls can unlink/relink these chats. Needs attention opens embedded conversations directly. Task completion stays manual.

### Authentication is an explicit launch choice

- Default: existing Claude Code sign-in, resolved by the official SDK. Sign in using the supported Claude Code CLI outside Deck (`claude auth login`) if needed. Deck does not read, copy, collect or provision tokens. Billing/limits follow the selected Claude Code account. Unrelated inherited API keys and token environment variables are excluded.
- Set `ACD_EMBEDDED_AUTH=api-key` to deliberately choose direct Anthropic API billing. Set `ANTHROPIC_API_KEY` in the environment that launches Electron. The UI identifies this mode; no key is sent to the renderer or saved by Deck. API mode uses a separate SDK config directory under the selected Deck data directory.
- OpenRouter: see the backend-only setup below. Other endpoints, API-key helpers and arbitrary authentication forwarding remain disabled.

The SDK overview/quickstart currently warn about offering claude.ai login in third-party products without prior approval. The newer [7 October support update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says SDK and third-party app usage can still draw from subscription limits. This personal prototype delegates existing local sign-in to the SDK; it does not implement its own login flow. Recheck applicable guidance before distributing a product.

`ACD_EMBEDDED_CHAT` defaults off; demo mode always disables execution. The original hook, tmux and external-chat paths remain intact. An existing tmux session is not taken over by the SDK: create a separate embedded chat for the task.

## Architecture and boundaries

- `src/shared/embedded-chat.ts`: strict Zod command protocol and renderer-safe normalized events. One validated, trusted-frame IPC channel crosses preload. No arbitrary shell/filesystem API is exposed to the renderer.
- `src/main/embedded-sdk.ts`: backend-only official `@anthropic-ai/claude-agent-sdk`, pinned to **0.3.302**. Uses documented `query`, async input, `resume`, partial messages, permission hooks/callbacks, abort and close APIs. The npm platform binary is included and unpacked in the Electron distribution.
- `src/main/embedded-chat.ts`: one active turn per chat, maximum three simultaneous chats, explicit auth environment replacement, exact native session resume, tool approval/input routing and durable history. A result completes a turn; process exit without a result is an error. No failed or textless turn is automatically resubmitted.
- Schema migration 16 adds a non-secret configuration fingerprint, provider and requested model to sessions. Legacy sessions retain history but require a fresh chat before execution. Migration 15 adds `embedded_sessions`, `embedded_events` and `embedded_sends`. Existing backup-before-migration behavior is preserved. Native session IDs are separate from Deck chat IDs and task IDs. Existing `plan_chats` is the canonical task association. Human names, notes, project choices, task links and archives survive execution updates.
- Every send has a fresh app idempotency key, persisted with a prompt digest in the same transaction as the user entry. Retrying that key cannot execute the turn twice, including after restart; a changed prompt with the same key is rejected. This key is not an SDK message UUID. Explicit new follow-ups get a fresh key.
- Normalized transcript entries are upserted before notifications; reload/reconnect reads backend history without sending prompts. Partial text and completed single-block SDK envelopes reconcile using the actual stream block index, including thinking-before-text cases. Duplicate completed SDK frames do not duplicate text. Hidden thinking is not rendered or stored.
- Each chat retains the latest 500 displayed events, capped at 30,000 characters per entry. This is a bounded activity view, not a full execution audit. SDK-owned session persistence provides model context on resume. If those SDK records are removed or inaccessible, resume may fail visibly; Deck does not silently start a replacement session.
- Closing the app/switching demo mode cancels owned queries and discards pending requests. Restart marks interrupted work idle, adds a visible interruption notice, and requires a new follow-up. Cancellation aborts and closes the query; an abort-aware iterator fence releases the turn even if a transport stops responding. Late events cannot mutate the next turn. Tool side effects already completed are not rolled back.

### Permissions and settings

`permissionMode: 'default'`, `settingSources: []`, `strictMcpConfig: true`, and an explicit built-in tool list are deliberate. No project/user hooks, skills, plugins or MCP servers are opted into this slice. Machine-managed policy may still apply; this is not an OS sandbox. HOME remains available so the SDK can resolve supported local authentication.

A `PreToolUse` hook asks for each tool call before the SDK's normal allow rules. `canUseTool` holds a specific request until the human denies, allows once, or submits complete `AskUserQuestion` answers via `updatedInput.answers`. It does not return persistent allow rules or arbitrary edited input. Tool input larger than the review limit is denied rather than approved from a truncated preview. Expired/cancelled requests cannot authorize execution. MCP elicitation is declined; it needs a separate designed input surface later. Tools run with the desktop user's privileges after approval.

## Verification

Run `npm run check:all` for type checking, backend/native tests, headless renderer tests and native Electron/IPC checks. Run `npm run package` and `npm run test:packaged` for the packaged app. New lifecycle tests cover task linkage/unlinking, separate same-folder sessions, exact resume, send deduplication across restart, partial/final block reconciliation, errors, questions, denial, cancellation and stale events. Browser tests use a clearly synthetic SDK transport fixture and cover task selection, history on reload, attention routing, pending request recovery, questions, errors, cancellation and restart.

`npm run smoke:embedded` initializes the real official SDK subprocess with a parked input stream. It sends **no prompt** and cannot establish inference access. `ACD_EMBEDDED_LIVE=1 npm run smoke:embedded -- --inference` deliberately performs two tools-disabled, harmless turns with session resume using the selected auth mode; it may consume subscription/API usage. It omits account details and model text from terminal evidence. Initialization success must not be reported as live inference success.

Historical evidence from the original macOS host (not this cloud checkout): Node 26.5.0, macOS arm64, SDK 0.3.302. The real SDK initialization probe succeeded. `claude auth status` reported no sign-in and no API key was configured, so live inference/resume was not attempted. Fixture evidence is labeled synthetic. See the handoff for final suite counts and screenshot locations. No Windows/WSL live claim is made.

## Wrapper design cross-checks

Public implementation references supplied by the parallel wrapper review:

- [T3 Code Claude adapter, pinned source](https://github.com/pingdotgg/t3code/blob/16918b57d6754d6f145e9b6367c825aa31a740da/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts): native session IDs, turn/result distinction, pending-request settlement, partial/final reconciliation and fenced cleanup.
- [T3 Code Claude home handling](https://github.com/pingdotgg/t3code/blob/16918b57d6754d6f145e9b6367c825aa31a740da/apps/server/src/provider/Drivers/ClaudeHome.ts): preserve HOME for supported keychain behavior; do not scrape/copy credentials.
- [MausBot Claude driver, pinned source](https://github.com/milind-soni/OpenMausBot/blob/62a7b7ac72e4f0adae1b373032592df7327d7b26/server/drivers/claude.ts): deliberate auth selection and no assumption that absent assistant text means tools had no side effects. That driver uses CLI stream-json; its APIs are not substituted for SDK APIs here.

Official references checked for this pinned integration: [overview](https://code.claude.com/docs/en/agent-sdk/overview), [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart), [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions). Installed SDK declarations are the version-specific API authority.

## Next Codex-sized tasks

1. Establish supported local sign-in and run the harmless two-turn live smoke; then verify an actual tool denial/approval and question without touching valuable files.
2. Add a reviewed project-trust/settings selector, explicit skill loading and visible effective configuration. Do not implicitly inherit hooks/MCP/allow rules while adding this.
3. Add draft persistence per embedded chat and a dedicated larger conversation layout; preserve pending requests across task navigation and expose richer structured question choices.
4. Add cursor-based event pagination/retention controls, budget/model controls, structured tool-result presentation and better redacted auth diagnostics.
5. Verify packaging and lifecycle on Windows/WSL, and define explicit SDK-session export/recovery behavior before moving history between machines.

Document annotation/review, retrieval, evidence tracing and orchestration remain separate product experiments.

## OpenRouter / DeepSeek trial (cloud preparation)

DeepSeek execution is **unverified** until an authorized live test succeeds. OpenRouter documents the [Agent SDK environment setup](https://openrouter.ai/docs/guides/community/anthropic-agent-sdk), but [guarantees Claude Code compatibility only for Anthropic first-party models](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration). This is a reasonable experiment, with fixture coverage rather than a claim of actual DeepSeek success. The pinned default is [DeepSeek V4.1 Flash 1017](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017), released October 17, 2026. The catalog context size does not establish the SDK harness context limit; no context-window override is applied.

Set only these non-secret launch settings:

```sh
export ACD_EMBEDDED_CHAT=1
export ACD_EMBEDDED_PROVIDER=openrouter
export ANTHROPIC_BASE_URL=https://openrouter.ai/api
export ANTHROPIC_API_KEY=''
export ACD_EMBEDDED_MODEL=deepseek/deepseek-v4.1-flash-1017
export ACD_EMBEDDED_HELPER_MODEL=deepseek/deepseek-v4.1-flash-1017
```

Inject `ANTHROPIC_AUTH_TOKEN` at runtime through the cloud secret mechanism. A Network secret placeholder can be used when the HTTPS proxy substitutes the actual credential. Do not put a credential in a command line, file, repository, packaged resources or renderer state. No custom secret-entry UI is provided. Preserve the cloud proxy/CA environment; the backend forwards upper/lowercase HTTP(S)/ALL/NO proxy variables, `NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `SSL_CERT_DIR`. If the cloud Node transport requires `NODE_USE_ENV_PROXY=1`, retain that launch setting too. Deck never prints the environment or raw subprocess errors.

Provider defaults to `anthropic`; its existing `ACD_EMBEDDED_AUTH=claude-code` and `api-key` modes remain available. The endpoint must match the selected provider (`https://api.anthropic.com` or `https://openrouter.ai/api`); arbitrary endpoints are rejected before execution. OpenRouter always passes an explicitly empty `ANTHROPIC_API_KEY` in the SDK subprocess environment, even if the cloud/parent variable is omitted or contains an unrelated key. If the cloud secret UI rejects empty values, omit `ANTHROPIC_API_KEY` there; the backend supplies the required empty string per SDK process without changing the parent environment. Keep `ACD_EMBEDDED_PROVIDER=openrouter` in the launch settings. Login/OAuth tokens, project settings, custom headers and inherited model overrides are excluded. Missing tokens and invalid provider/model/endpoint settings fail before a send is recorded. Credential presence does not establish validity, credits or proxy substitution.

`ACD_EMBEDDED_MODEL` sets the SDK `options.model` and `ANTHROPIC_MODEL`. The helper model defaults to that same model; `ACD_EMBEDDED_HELPER_MODEL` may explicitly override it. The helper sets `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`. These variables occur in the pinned SDK runtime; tests verify propagation, not that every internal runtime path honors them against a live provider. No Claude fallback model is configured. The embedded tool allowlist currently excludes Agent/Task subagent spawning.

Each chat records provider, requested main model and a fingerprint of provider, authentication mode, endpoint, main model and helper model. Credentials are excluded. Changing these settings requires restarting the backend and creating a new embedded chat for the task; Deck refuses to resume an incompatible or legacy session. Previous history, task links and human metadata stay available. Rotating a credential does not change session identity. Model routing aliases can change remotely, so prefer pinned model IDs. SDK session records remain owned by the SDK under the selected data/config directory.

### Verification and optional paid smoke

`npm run check` exercises synthetic backend/configuration fixtures and headless renderer flows. Coverage includes main/helper/env propagation, proxy preservation, credential isolation, safe diagnostic categories, session identity changes and legacy migration, alongside existing stream reconciliation, tools/questions, ownership, cancellation, restart and resume fixtures. Those tests make no model calls.

`npm run smoke:embedded` is an optional real SDK initialization probe; it submits no prompt and proves neither credentials nor inference access. It was not run as part of this cloud preparation. After credential injection and **separate spending approval**, this command opts into live inference:

```sh
ACD_EMBEDDED_LIVE=1 npm run smoke:embedded -- --inference
```

The live path uses an isolated temporary folder, disables tools, allows at most one turn per query, sets `maxBudgetUsd=0.025` per query (two queries, nominal total $0.05), and aborts after 25 seconds across both. SDK budgets are runtime controls, not a provider-side hard billing guarantee; set a cloud/OpenRouter key spending limit as well. It asserts READY, a streamed text delta, a saved session ID, then exact-session resume recalling the synthetic word orchard. It prints no account details, credential values or response text. Failures do not trigger retries or fallback. This covers live text/stream/resume only; actual tool approval/questions still require an explicitly authorized integration trial in a disposable workspace. No live or paid tests were run during preparation.

Cloud preparation evidence (Linux x64, Node 24.19.0, 18 October 2026): type checking, production build and all 14 commit-guard unit tests passed. Final backend run: 175 tests, 173 passed, one Windows-only skip and one failure in `repository repair retries when Git markers become available and backs up current data` (backup count 1 versus expected 0). The same failure was reproduced using the original `08503d2` store implementation; it is outside this provider change. All 17 embedded chat/configuration tests passed, including the live opt-in refusal test, which never invokes a query. Renderer tests could not launch because Chromium was absent; installing it under `/tmp` was blocked by a cloud-network 403 `Domain forbidden` from the Playwright download domain. `npm ci` also encountered unwritable default caches; `/tmp` cache settings and `NODE_USE_ENV_PROXY=1` allowed installation of the Electron executable, but electron-builder's rebuild step still attempted the unwritable `/home/agent/.electron-gyp`. Existing backend tests and the app build nevertheless ran. No complete clean-install, renderer, native-window, packaging, real SDK initialization or DeepSeek inference success is claimed. No live or paid model tests were run.

Mac verification (macOS arm64, Node 26.5.0, 18 October 2026): clean `npm ci` succeeded with zero reported vulnerabilities. `npm run check` passed: 14 commit-guard tests, type checking, 175 backend tests passed with one Windows-only skip, production build and 25 headless browser tests. The cloud repository-backup failure did not reproduce. `npm run test:electron -- --grep-invert 'official SDK subprocess'` passed all four selected native window/IPC tests; the real SDK account probe was deliberately excluded. Review also added denial of tool inputs containing the runtime credential, including structured question fields, with a synthetic regression assertion. No credentials were provisioned, no live model inference was run, and packaging was not rerun because dependencies and packaging configuration are unchanged.
