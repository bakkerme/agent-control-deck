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
- Alternate cloud providers, custom API endpoints, API-key helpers and arbitrary authentication environment forwarding are not configured by this experiment.

The SDK overview/quickstart currently warn about offering claude.ai login in third-party products without prior approval. The newer [7 October support update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says SDK and third-party app usage can still draw from subscription limits. This personal prototype delegates existing local sign-in to the SDK; it does not implement its own login flow. Recheck applicable guidance before distributing a product.

`ACD_EMBEDDED_CHAT` defaults off; demo mode always disables execution. The original hook, tmux and external-chat paths remain intact. An existing tmux session is not taken over by the SDK: create a separate embedded chat for the task.

## Architecture and boundaries

- `src/shared/embedded-chat.ts`: strict Zod command protocol and renderer-safe normalized events. One validated, trusted-frame IPC channel crosses preload. No arbitrary shell/filesystem API is exposed to the renderer.
- `src/main/embedded-sdk.ts`: backend-only official `@anthropic-ai/claude-agent-sdk`, pinned to **0.3.302**. Uses documented `query`, async input, `resume`, partial messages, permission hooks/callbacks, abort and close APIs. The npm platform binary is included and unpacked in the Electron distribution.
- `src/main/embedded-chat.ts`: one active turn per chat, maximum three simultaneous chats, explicit auth environment replacement, exact native session resume, tool approval/input routing and durable history. A result completes a turn; process exit without a result is an error. No failed or textless turn is automatically resubmitted.
- Schema migration 15 adds `embedded_sessions`, `embedded_events` and `embedded_sends`. Existing backup-before-migration behavior is preserved. Native session IDs are separate from Deck chat IDs and task IDs. Existing `plan_chats` is the canonical task association. Human names, notes, project choices, task links and archives survive execution updates.
- Every send has a fresh app idempotency key, persisted with a prompt digest in the same transaction as the user entry. Retrying that key cannot execute the turn twice, including after restart; a changed prompt with the same key is rejected. This key is not an SDK message UUID. Explicit new follow-ups get a fresh key.
- Normalized transcript entries are upserted before notifications; reload/reconnect reads backend history without sending prompts. Partial text and completed single-block SDK envelopes reconcile using the actual stream block index, including thinking-before-text cases. Duplicate completed SDK frames do not duplicate text. Hidden thinking is not rendered or stored.
- Each chat retains the latest 500 displayed events, capped at 30,000 characters per entry. This is a bounded activity view, not a full execution audit. SDK-owned session persistence provides model context on resume. If those SDK records are removed or inaccessible, resume may fail visibly; Deck does not silently start a replacement session.
- Closing the app/switching demo mode cancels owned queries and discards pending requests. Restart marks interrupted work idle, adds a visible interruption notice, and requires a new follow-up. Cancellation aborts and closes the query; an abort-aware iterator fence releases the turn even if a transport stops responding. Late events cannot mutate the next turn. Tool side effects already completed are not rolled back.

### Permissions and settings

`permissionMode: 'default'`, `settingSources: []`, `strictMcpConfig: true`, and an explicit built-in tool list are deliberate. No project/user hooks, skills, plugins or MCP servers are opted into this slice. Machine-managed policy may still apply; this is not an OS sandbox. HOME remains available so the SDK can resolve supported local authentication.

A `PreToolUse` hook asks for each tool call before the SDK's normal allow rules. `canUseTool` holds a specific request until the human denies, allows once, or submits complete `AskUserQuestion` answers via `updatedInput.answers`. It does not return persistent allow rules or arbitrary edited input. Tool input larger than the review limit is denied rather than approved from a truncated preview. Expired/cancelled requests cannot authorize execution. MCP elicitation is declined; it needs a separate designed input surface later. Tools run with the desktop user's privileges after approval.

## Verification

Run `npm run check:all` for type checking, backend/native tests, headless renderer tests and native Electron/IPC checks. Run `npm run package` and `npm run test:packaged` for the packaged app. New lifecycle tests cover task linkage/unlinking, separate same-folder sessions, exact resume, send deduplication across restart, partial/final block reconciliation, errors, questions, denial, cancellation and stale events. Browser tests use a clearly synthetic SDK transport fixture and cover task selection, history on reload, attention routing, pending request recovery, questions, errors, cancellation and restart.

`npm run smoke:embedded` initializes the real official SDK subprocess with a parked input stream. It sends **no prompt** and cannot establish inference access. `npm run smoke:embedded -- --inference` deliberately performs two tools-disabled, harmless turns with session resume using the selected auth mode; it may consume subscription/API usage. It omits account details and model text from terminal evidence. Initialization success must not be reported as live inference success.

Evidence from this host: Node 26.5.0, macOS arm64, SDK 0.3.302. The real SDK initialization probe succeeded. `claude auth status` reported no sign-in and no API key was configured, so live inference/resume was not attempted. Fixture evidence is labeled synthetic. See the handoff for final suite counts and screenshot locations. No Windows/WSL live claim is made.

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
