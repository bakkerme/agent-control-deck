# Desktop hooks and data flow

## Setup

Create a source in the app for each provider/environment. A source owns its authentication token, inbox, and diagnostics. Merge its generated JSON into the matching provider configuration without replacing unrelated settings or hooks:

- Codex: `$CODEX_HOME/hooks.json` (normally `~/.codex/hooks.json`; inside WSL for a WSL source). Review/trust hooks through `/hooks` before testing.
- Claude Code: `~/.claude/settings.json` (inside WSL for a WSL source).
- Cursor: `~/.cursor/hooks.json` in the native Windows/macOS user profile.

Claude uses documented `type: "http"` hooks and POSTs its JSON input directly. Cursor and Codex do not document a native HTTP hook type; their command hooks forward stdin with `curl`. Native Windows uses `curl.exe`, avoiding the PowerShell alias. No generated collector scripts or separate Node/Python runtime are needed. Command hooks need curl on the provider's PATH.

All sources discover chats on `UserPromptSubmit` / `beforeSubmitPrompt`. `SessionStart` / `sessionStart` are not registered. This lets you enable monitoring and return to an existing chat: its next prompt carries the stable conversation ID and workspace, creates an entry, and opens its lifecycle. Completion, notification, error, and end events update known chats but do not create unused chats. Existing deck chats and all user-owned edits remain intact.

Keep the deck running to receive events. Requests sent while it is closed are not captured or assumed to replay. Once accepted, events are queued durably before ingestion, including when ingestion is paused. HTTP responses contain no provider text, approvals, prompts, or context. Collector connection/HTTP errors are non-blocking under the documented provider behavior; command forwarding has a two-second delivery limit and hooks have a three-second timeout.

### Replacing old file collectors

Replace only the deck's old hook entries with the new fragment, removing its SessionStart entries and script commands. Preserve unrelated hooks/settings. The app stops generating collector scripts but does not edit provider configuration or remove older user-data files automatically. Existing pending inbox files still drain through the normal reader. Credentials live under `hooks/<source-id>/http-token` and survive restarts; configuration fragments contain them, so keep these files private.

First use **Send diagnostic event** to test the local inbox reader. The Sources page provides a curl command and labelled JSON input to test HTTP from the provider environment. Send a real prompt in an existing provider chat to confirm that the provider loaded the hooks. Reopen/restart the provider if configuration has not been reloaded. Pause/resume affects ingestion, not HTTP acceptance; remove the deck entries in the provider settings to uninstall hooks.

### WSL networking

Create WSL sources in the Windows deck and configure the provider inside that distro, using a separate source per distro. Paths remain Linux paths; no `wslpath` or Windows drive mount is needed for delivery.

The receiver defaults to IPv4 loopback on port **43821**. With WSL2 mirrored networking, Windows is reachable from WSL using `127.0.0.1`. With default WSL2 NAT, WSL must use the Windows host IP, and the Windows listener must bind an address reachable from WSL. VPN/firewall policy can affect connectivity; validate from the actual distro. See [Microsoft's WSL networking guide](https://learn.microsoft.com/en-us/windows/wsl/networking).

Optional environment variables, set before launching the deck:

- `ACD_HTTP_HOST`: listener IP; defaults to `127.0.0.1`. For NAT, use the Windows WSL-facing interface IP where available. `0.0.0.0` explicitly opts into listening on all IPv4 interfaces, including LAN interfaces.
- `ACD_HTTP_PORT`: stable receiver port; defaults to `43821`. Use an available port and regenerate/remerge hooks if it changes. `0` selects a temporary port for isolated tests, not everyday setup.
- `ACD_WSL_HOOK_URL`: HTTP origin used in WSL source fragments, for example `http://172.30.0.1:43821`. It changes the destination only; it does not change the listener binding. Native sources continue to use the listener address (loopback when wildcard-bound).

Configure the binding and WSL destination together, restrict any needed inbound firewall rule to WSL, then replace the generated provider fragments. NAT host addresses may change after reboot, requiring regeneration; mirrored mode avoids that address dependency. The app does not change networking or firewall configuration automatically. Bind errors (including a port in use) are reported at startup without resetting the database. Per-source authentication applies on every interface; requests carrying browser Origin/Fetch Metadata headers are rejected, and no CORS access is enabled. Claude HTTP hooks may also be subject to workplace hook URL allowlists.

## Observed events

Codex adapter (native lifecycle hooks, separate from Cursor):

- UserPromptSubmit reports running and uses the first observed prompt as the default title.
- Stop reports idle and captures the last assistant message when supplied; it does not mark the session ended.
- Interrupt reports idle with an interruption entry.
- SessionEnd retains the chat and marks the session ended. Changing the selected Codex chat does not necessarily end its session.

Configuration uses Codex's nested command-hook schema in `.codex/hooks.json`, not Cursor's `.cursor/hooks.json`. The HTTP receiver returns `{}` for Stop, and otherwise an empty body; it never blocks, approves, injects context, or asks the agent to continue. End/interrupt hooks use a three-second timeout. Existing hooks must be preserved when merging. Codex requires review and trust of new or changed hook definitions; the app does not bypass that check. If `CODEX_HOME` is customized, use that location instead of `~/.codex`.

This adapter intentionally uses lifecycle events only. It has no approval-wait or dedicated failure signal, does not read transcripts, and does not import old conversations. It has HTTP forwarding and UI fixture coverage; real events require a trusted hook installation. See the [official Codex hooks reference](https://learn.chatgpt.com/docs/hooks).

Codex's documented hook inputs do not include the sidebar chat title. Default deck titles are derived from the first observed request; attachment preambles are skipped, with the attachment label used when there is no request text. Existing flattened attachment titles are cleaned for display without changing the stored data or user names. Names entered in the deck always take priority and stay local.

New previews preserve Markdown line breaks within the 500-character limit. The renderer supports headings, lists, emphasis, code, and tables as safe React elements. Raw HTML remains inert text, links do not navigate, and images are shown as text labels. Previously flattened or truncated previews cannot regain their original formatting; a new event supplies a fresh preview.

Claude Code adapter:

- UserPromptSubmit reports running and captures a bounded prompt preview.
- Stop reports idle and uses the last assistant message when present.
- StopFailure reports an error.
- Notification reports waiting for `permission_prompt` or `elicitation_dialog`; `idle_prompt` reports idle. Other notifications add activity without guessing a state.
- SessionEnd marks the session ended without deleting its chat.

Cursor adapter:

- beforeSubmitPrompt reports running; HTTP returns only the neutral continuation response.
- afterAgentResponse updates the preview without declaring that the turn ended.
- stop reports idle or error according to its status; an aborted turn is idle with an explanatory activity entry.
- sessionEnd marks the session ended without deleting its chat.

Cursor has no attention signal in this registered hook set, so the app does not infer one. Tool, permission-control, reasoning, and transcript-reading hooks are deliberately absent. No receiver response submits follow-up prompts or approval decisions. Forwarding errors do not request intervention or block the agent.

References: [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Cursor hooks](https://cursor.com/docs/hooks).

## Inbox protocol

The main process receives `POST /hooks/<source-id>/<event>` with that source's bearer token and `Content-Type: application/json`. Only registered lifecycle events are accepted. Event names must match the route and identities must validate. Request bodies and queued envelopes are limited to 256 KiB. Eight simultaneous bodies and sixteen connections bound receiver resource use. Responses never echo input or internal errors.

After validation, the receiver wraps the payload in a version-1 envelope with a unique `eventId` and server `observedAt`, fsyncs its queue file, and atomically renames it before acknowledging success. An optional `X-Deck-Event-Id` enables deduplication for clients deliberately retrying a request with the same ID. Provider HTTP delivery is not assumed to retry or supply that header. Inbox capacity is 1,000 pending events per source; unavailable/full storage refuses acceptance rather than reporting success.

Each source has its own inbox. Events cannot select another source or write user-owned fields. The app scans every second in batches of 100, processes regular JSON files up to 256 KiB, validates envelopes/provider identity, and commits observations and event IDs together. Processed files are removed after commit. Duplicate event IDs are ignored, including after restart. Older observations enter history but do not replace newer state. For legacy files without a producer timestamp, modification time supplies the observation timestamp.

Queued payloads may contain prompt/response text until consumed. Pending files older than seven days and abandoned temporary files older than one day are discarded. Rejected counts and source errors are visible; raw payloads are not logged or retained as activity. Disk/database failures retain pending events for retry. Demo mode rejects incoming HTTP events and keeps separate storage, credentials, and inboxes.

## Projects and identity

Chat identity is scoped to source and provider external conversation ID. Multiple conversations in one workspace remain separate. New workspace locations create projects; aliases map explicit locations to existing projects. The longest matching absolute workspace path wins, using directory boundaries. Windows paths are normalized case-insensitively; POSIX paths remain case-sensitive.

Aliases affect newly discovered chats. Move existing chats with the Project selector, or choose **No project** to remove their assignment. Later provider events preserve this choice. Paths from different sources are not automatically merged by basename. Providers supplying no workspace start under **No project**.

## Persistence and boundaries

SQLite stores projects, sources, path aliases, chats, bounded activity, and processed-event IDs. User fields are separate from provider observations. State is last reported activity, not process liveness. No timeout silently completes work. Archive state is always user-owned.

`PRAGMA user_version` tracks schema migrations. Existing databases are checkpointed/backed up before migration. Databases from newer app versions are rejected instead of reset. Demo mode uses separate storage and inboxes.

The former Python bridge and StatusSnapshot wire schema are not the desktop API. The app exposes only its preload IPC methods, validated in Electron's main process. Its local HTTP listener accepts authenticated hook observations only; it has no agent-control, cloud, or Jira API.
