# Desktop hooks and data flow

## Setup

Create a source in the app for each provider/environment. A source owns its authentication token, inbox, and diagnostics. Merge its generated JSON into the matching provider configuration without replacing unrelated settings or hooks:

- Codex: `$CODEX_HOME/hooks.json` (normally `~/.codex/hooks.json`; inside WSL for a WSL source). Review/trust hooks through `/hooks` before testing.
- Claude Code: `~/.claude/settings.json` (inside WSL for a WSL source).
- Cursor: `~/.cursor/hooks.json` in the native Windows/macOS user profile.

Native Claude uses documented `type: "http"` hooks and POSTs its JSON input directly. For WSL sources configured by the Windows deck, Claude instead uses `type: "command"` hooks invoking `"/mnt/c/Windows/System32/curl.exe"` through WSL interoperability. Cursor and Codex do not document a native HTTP hook type; their command hooks forward stdin with curl (the same absolute executable path for Windows/WSL sources, `curl.exe` for native Windows sources). No generated collector scripts or separate Node/Python runtime are needed. WSL command hooks do not depend on Windows directories being on the provider's PATH; other command hooks need curl on PATH.

All sources discover chats on `UserPromptSubmit` / `beforeSubmitPrompt`. `SessionStart` / `sessionStart` are not registered. This lets you enable monitoring and return to an existing chat: its next prompt carries the stable conversation ID and workspace, creates an entry, and opens its lifecycle. Completion, notification, error, and end events update known chats but do not create unused chats. Existing deck chats and all user-owned edits remain intact.

Keep the deck running to receive events. Requests sent while it is closed are not captured or assumed to replay. Once accepted, events are queued durably before ingestion, including when ingestion is paused. HTTP responses contain no provider text, prompts, or context. Command hooks discard transport output and finish successfully even when the deck is closed, curl is missing, or the receiver refuses delivery. They always emit the fixed neutral response expected by Cursor beforeSubmitPrompt (`{"continue":true}`), Cursor subagentStart (`{"permission":"allow"}`), or Codex Stop/SubagentStop (`{}`), and otherwise no output. These responses never depend on provider content or delivery success. Native Claude HTTP hooks remain non-blocking on connection failure, but Claude may display an error notice for that transport. Command forwarding has a two-second delivery limit and hooks have a three-second timeout.

### Replacing old file collectors

Replace only the deck's old hook entries with the new fragment, removing its SessionStart entries and script commands. Preserve unrelated hooks/settings. The app stops generating collector scripts but does not edit provider configuration or remove older user-data files automatically. Existing pending inbox files still drain through the normal reader. Credentials live under `hooks/<source-id>/http-token` and survive restarts; configuration fragments contain them, so keep these files private.

First use **Send diagnostic event** to test the local inbox reader. The **Settings → Sources** section provides a curl command and labelled JSON input to test HTTP from the provider environment. This diagnostic command preserves curl's failure exit status; installed command hooks deliberately suppress delivery failures. Send a real prompt in an existing provider chat to confirm that the provider loaded the hooks. Reopen/restart the provider if configuration has not been reloaded. Pause/resume affects ingestion, not HTTP acceptance; remove the deck entries in the provider settings to uninstall hooks.

### WSL networking

Create WSL sources in the Windows deck and configure the provider inside that distro, using a separate source per distro. Paths remain Linux paths. The generated command launches **Windows `curl.exe`** from WSL and pipes the JSON hook payload to its stdin:

**Provider in WSL → Windows curl.exe → Windows loopback HTTP receiver → durable inbox**

The receiver defaults to `127.0.0.1:43821`. The HTTP request originates from a Windows process, so it does not cross the WSL virtual network or require an inbound WSL-to-Windows firewall exception. This works independently of WSL NAT versus mirrored networking, provided Windows executable interoperability is enabled and Windows curl is available. No PowerShell, external proxy, collector script, or WSL host-IP configuration is used. See [Microsoft's Windows executable interoperability documentation](https://learn.microsoft.com/en-us/windows/wsl/filesystems#run-windows-tools-from-linux).

From the same WSL environment used by the provider:

```bash
"/mnt/c/Windows/System32/curl.exe" --version
"/mnt/c/Windows/System32/curl.exe" --noproxy "*" --max-time 3 -i http://127.0.0.1:43821/
```

With the deck running on the default address, **405 Method Not Allowed** confirms receiver reachability: GET is intentionally unsupported. Then use the authenticated test command and input shown in Sources, and submit a real prompt in an existing chat. The local **Send diagnostic event** button alone does not test interoperability or HTTP.

The generated path assumes Windows is installed at `C:\Windows` and WSL mounts the C drive at `/mnt/c`. If the executable is not found, adjust the quoted absolute path in the hook commands for your Windows drive or WSL mount root. There is no need to import the Windows PATH into Linux. If Windows execution is blocked by workplace policy, this transport cannot be assumed to work; use an approved transport such as a shared-file inbox instead. The app does not change WSL or security settings automatically.

### Migrating an earlier NAT setup

Restart the Windows deck after restoring `ACD_HTTP_HOST` to `127.0.0.1` (or removing the override). `ACD_WSL_HOOK_URL` is no longer used. Replace only the deck's old HTTP/script hook entries with the new curl command entries from Sources, preserving unrelated provider settings. Keep the same source to preserve identity, tokens, notes, and project mappings. No additional firewall rule is needed for the Windows-loopback route; an earlier rule is not used by it.

Optional environment variables, set before launching the deck:

- `ACD_HTTP_HOST`: listener IP; defaults to `127.0.0.1`. Keep loopback for native and WSL interoperability delivery. `0.0.0.0` explicitly opts into listening on all IPv4 interfaces, including LAN interfaces, and is unnecessary for this setup.
- `ACD_HTTP_PORT`: stable receiver port; defaults to `43821`. Use an available port and regenerate/remerge hooks if it changes. `0` selects a temporary port for isolated tests, not everyday setup.

Bind errors (including a port in use) are reported at startup without resetting the database. Per-source authentication applies on every interface; browser Origin/Fetch Metadata requests are rejected and no CORS access is enabled. Workplace rules for user-defined command hooks and Windows interoperability still apply. Automated macOS fixtures check generation and curl payload delivery; they do not prove real Windows/WSL execution or workplace policy compatibility.

## Observed events

Codex adapter (native lifecycle hooks, separate from Cursor):

- UserPromptSubmit reports running and uses the first observed prompt as the default title.
- Stop reports idle and captures the last assistant message when supplied; it does not mark the session ended.
- SubagentStart and SubagentStop track each observed worker by agent ID in its parent session, independently of the main turn. Subagent responses do not overwrite the main chat preview.
- Interrupt reports idle with an interruption entry.
- SessionEnd retains the chat and marks the session ended. Changing the selected Codex chat does not necessarily end its session.

Configuration uses Codex's nested command-hook schema in `.codex/hooks.json`, not Cursor's `.cursor/hooks.json`. The HTTP receiver returns `{}` for Stop and SubagentStop, and otherwise an empty body; it never blocks, injects context, or asks the agent to continue. End/interrupt hooks use a three-second timeout. Existing hooks must be preserved when merging. Codex requires review and trust of new or changed hook definitions; the app does not bypass that check. If `CODEX_HOME` is customized, use that location instead of `~/.codex`.

This adapter intentionally uses lifecycle events only. It has no approval-wait or dedicated failure signal, does not read transcripts, and does not import old conversations. It has HTTP forwarding and UI fixture coverage; real events require a trusted hook installation. See the [official Codex hooks reference](https://learn.chatgpt.com/docs/hooks).

Codex's documented hook inputs do not include the sidebar chat title. Default deck titles are derived from the first observed request; attachment preambles are skipped, with the attachment label used when there is no request text. Existing flattened attachment titles are cleaned for display without changing the stored data or user names. Names entered in the deck always take priority and stay local.

New previews preserve Markdown line breaks within the 500-character limit. The renderer supports headings, lists, emphasis, code, and tables as safe React elements. Raw HTML remains inert text, links do not navigate, and images are shown as text labels. Previously flattened or truncated previews cannot regain their original formatting; a new event supplies a fresh preview.

Claude Code adapter:

- UserPromptSubmit reports running and captures a bounded prompt preview.
- PostToolUse and PostToolUseFailure report running after a tool returns, including when you answer AskUserQuestion or approve a permission prompt without submitting another prompt. A tool error does not imply that the turn failed; an explicit interrupted tool failure reports idle. ElicitationResult reports running after an MCP input response.
- Stop reports idle and uses the last assistant message when present.
- SubagentStart and SubagentStop observe worker activity separately. When Stop or SubagentStop includes the documented `background_tasks` array, its subagent entries provide a fresh snapshot of background work. An empty array clears previous observations; an absent array does not imply that background work finished. Registry task IDs and lifecycle agent IDs are treated as separate identities.
- The same Stop/SubagentStop payloads also report other in-flight `background_tasks` and `session_crons` (session-scoped scheduled wakeups). The deck retains task types, statuses and descriptions, plus scheduled checks' schedules, recurrence and bounded prompt text. A background monitor or pending schedule keeps an idle chat in **Monitoring**, with **Monitoring · waiting for next check** for scheduled checks. Other recently observed background tasks count as Running. Monitoring has its own filter and footer count, and outstanding background observations keep a chat out of Finished turns and completion priority alerts. Needs input and Error still take priority.
- StopFailure reports an error.
- Notification reports waiting for `permission_prompt` or `elicitation_dialog`; `idle_prompt` reports idle. Other notifications add activity without guessing a state.
- SessionEnd marks the session ended without deleting its chat.

Replace the deck's Claude hook entries with the updated fragment from Sources to capture resume and subagent events, preserving unrelated hooks. See the [official Claude hooks reference](https://code.claude.com/docs/en/hooks#posttooluse).

Cursor adapter:

- beforeSubmitPrompt reports running; HTTP returns only the neutral continuation response.
- afterAgentResponse updates the preview without declaring that the turn ended.
- stop reports idle or error according to its status; an aborted turn is idle with an explanatory activity entry.
- sessionEnd marks the session ended without deleting its chat.
- subagentStart links a worker to its parent conversation. subagentStop ends the matching worker when an instance ID is supplied. Cursor's documented stop payload can omit that ID; the deck then marks outstanding observations uncertain instead of guessing which parallel worker stopped.

Cursor has no attention signal in this registered hook set, so the app does not infer one. Cursor tool hooks and all providers' permission-control, reasoning, and transcript-reading hooks are deliberately absent. Claude tool-return hooks observe resumed work only. No receiver response submits follow-up prompts or approval decisions. Forwarding errors do not request intervention or block the agent.

References: [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Cursor hooks](https://cursor.com/docs/hooks).

### Main turns and subagent observations

The main turn state and worker observations are stored separately. The UI can show **Running · 2 subagents working** or **Main turn finished · 2 subagents working**. Chats with recently observed workers appear in Running, including the footer count, and do not appear in Finished turns. Waiting/error states retain priority when the main agent needs attention. Once all observed workers finish responding, an idle main chat returns to Turn finished; this is not a claim that the user's entire task is complete.

Subagent observations survive restarts, archiving, and provider updates without changing names, notes, tickets, or project assignments. Delayed events are ordered per worker independently of main-chat events. SessionEnd marks outstanding workers uncertain; Interrupt affects the main turn without assuming it stopped the workers. Unidentified stop events and snapshots without enough identity information also retain uncertainty. The UI marks a worker uncertain after five minutes without a fresh observation, displays observation age in Subagent observations, and never infers completion from silence. Providers do not supply a subagent heartbeat through this hook set, so even a healthy long-running worker may become uncertain.

Merge the updated fragment from Sources for each existing source to enable these events, preserving unrelated provider hooks; review/trust the new Codex entries. Events before installation or while the deck was closed cannot be reconstructed from hooks. Provider-version compatibility and actual background completion delivery require a real run on the target host; macOS fixtures do not establish Windows/WSL behavior. No transcripts or provider storage are read. Storage retains at most 1,000 outstanding worker observations and 1,000 completed identities per chat; exceeding outstanding capacity leaves accepted inbox events queued for retry.

### Background monitoring and scheduled checks

Claude monitoring detection uses the **existing Stop and SubagentStop hook configuration**; no new hook entries or trust changes are required if those events already forward their complete payloads. A Claude version that supplies `background_tasks` and `session_crons` is required. Custom forwarders that strip fields must preserve these arrays. Codex and Cursor retain subagent observation support; their documented hooks do not establish an equivalent monitoring/scheduled-check snapshot, so the deck does not infer monitoring from response text.

Background observations survive restart and user edits. Each array is an independent snapshot: absent fields retain prior observations, explicit empty arrays clear them, and delayed snapshots cannot resurrect cleared work. Payloads are validated and bounded to 1,000 entries per array. No received snapshot means no automatic reconstruction of an existing monitor.

**Background work and scheduled checks** in chat details shows the last observation age. In-flight task observations become uncertain after five minutes without a refresh. Schedules can intentionally wait longer, so a reported schedule stays pending until a newer snapshot clears it; the deck does not claim the scheduler is alive, calculate the next firing time, or expire one-time checks from the cron expression. SessionEnd marks outstanding background observations uncertain. Completion between received snapshots is not observable, and silence never establishes completion. This remains read-only observation and does not create, cancel, or control tasks or schedules.

## Archiving and restoring chats

Archiving in the deck hides a chat from Active chats and preserves its name, notes, tickets, project, and recorded activity. Use Archived chats, select the chat, and choose Restore chat to return it to the active view. Provider events still update archived chats without restoring them automatically. New conversation IDs create separate active chats in the same project; resuming the same conversation ID updates its existing record. Project counts follow the selected active/archive view, and switching views clears search and status/provider filters.

## Inbox protocol

The main process receives `POST /hooks/<source-id>/<event>` with that source's bearer token and `Content-Type: application/json`. Only registered observation events are accepted. Event names must match the route and identities must validate. Request bodies and queued envelopes are limited to 256 KiB. Eight simultaneous bodies and sixteen connections bound receiver resource use. Responses never echo input or internal errors.

After validation, the receiver wraps the payload in a version-1 envelope with a unique `eventId` and server `observedAt`, fsyncs its queue file, and atomically renames it before acknowledging success. An optional `X-Deck-Event-Id` enables deduplication for clients deliberately retrying a request with the same ID. Provider HTTP delivery is not assumed to retry or supply that header. Inbox capacity is 1,000 pending events per source; unavailable/full storage refuses acceptance rather than reporting success.

Each source has its own inbox. Events cannot select another source or write user-owned fields. The app scans every second in batches of 100, processes regular JSON files up to 256 KiB, validates envelopes/provider identity, and commits observations and event IDs together. Processed files are removed after commit. Duplicate event IDs are ignored, including after restart. Older observations enter history but do not replace newer state. For legacy files without a producer timestamp, modification time supplies the observation timestamp.

Queued payloads may contain prompt/response text until consumed. Pending files older than seven days and abandoned temporary files older than one day are discarded. Rejected counts and source errors are visible; raw payloads are not logged or retained as activity. Disk/database failures retain pending events for retry. Demo mode rejects incoming HTTP events and keeps separate storage, credentials, and inboxes.

## Projects and identity

Chat identity is scoped to source and provider external conversation ID. Multiple conversations in one workspace remain separate. New workspace locations create default repository projects. For native sources, accessible Git location markers (`.git` and `commondir`) identify the shared repository directory: the main checkout and linked worktrees share one project across providers, while independent clones and nested repositories retain separate projects. Only these location markers are read; the app does not invoke Git or inspect provider storage or repository content. Broken or unavailable markers do not establish shared identity. Paths unavailable to the host, including WSL locations, use explicit source-scoped aliases. The longest matching alias wins, using directory boundaries. Windows paths are normalized case-insensitively; POSIX paths remain case-sensitive. See [Git's repository layout](https://git-scm.com/docs/gitrepository-layout) for the marker format.

All project display names can be renamed with the sidebar pencil. Renaming keeps the project's ID and path mappings intact, including names from older databases. Existing path mappings remain stable; add aliases for other locations of the same repository. A chat belongs only to its current **Project**. Moving it replaces its membership, and choosing **No project** removes its membership; it no longer appears in the original repository's list, counts, or priority alerts. The detected repository is retained as source context and a default for new chats. Provider updates preserve user choices. The final **Add a new project** option opens a name dialog and moves the selected chat into it. The same sidebar action creates and selects an empty custom project. Paths from different sources are never merged by basename. Providers supplying no workspace start under **No project**; later observations can record their repository origin without changing their chosen project.

The earlier repository migration preserves existing project names, assignments, notes, tickets, archives, and activity, and backs up the database first. Projects already used by workspace mappings become repository defaults. Older mappings to the same accessible local Git root join one repository default; other existing project names and assignments remain available as custom groupings. Existing chats keep their project choice, while matching source/project mappings establish their detected repository origin. Previously moved or unassigned chats can gain this source context when their provider next reports a workspace.

Version 7 also consolidates existing worktree defaults when accessible Git markers prove they share a repository. The established repository project, or the main checkout's project, retains its editable label; priority flags are combined. Chats still assigned to duplicate repository defaults and their path aliases move to that shared default. Genuine custom assignments and No project choices remain unchanged. Old duplicate project records and names remain in SQLite for recovery, with those duplicate sidebar entries suppressed. Startup retries this reconciliation when previously unavailable markers become accessible, backing up before any repair. Explicit aliases spanning separate clones remain intact. Removed/inaccessible worktrees whose identity was never recorded cannot be automatically consolidated; no grouping is inferred from a directory name.

## Persistence and boundaries

SQLite stores projects, sources, path aliases, chats, detected links, bounded activity, and processed-event IDs. User fields are separate from provider observations. State is last reported activity, not process liveness. No timeout silently completes work. Archive state is always user-owned.

Version 8 adds detected links without changing existing chat metadata. Codex and Claude `Stop` / `SubagentStop` observations scan `last_assistant_message` when supplied; Cursor `afterAgentResponse` scans `text` (and `stop` can supply `last_assistant_message`). Detection runs on the supplied text before its 500-character preview is created. Collection starts with new observations; old discarded response bodies cannot be recovered. Prompts and tool results are not scanned, and transcripts are not read.

Only explicit HTTP/HTTPS URLs without embedded credentials are collected. Markdown labels are retained as plain text; otherwise the address is displayed. URLs are canonicalized using the URL parser and deduplicated per chat. Each observation collects at most 100 unique links; each chat retains its 1,000 most recently observed URLs. Link insertion, event deduplication and chat observation are one transaction, so storage failures remain retryable through the inbox. Late responses can add links without replacing a newer label or regressing observation times.

**Settings → Link categories** stores up to 50 rules with an exact domain, optional path prefix and category name. Domain matching does not include subdomains. Paths match at directory boundaries; the longest matching path wins, and unmatched links use **Other**. Rules apply when links are displayed, so changing or removing a rule recategorizes saved URLs. The project stack includes links from all chats currently assigned to that project, independently of chat search, status and archive filters; the selected-chat stack shows its own links. Archived chat context remains reachable through source shortcuts. Overflow in the compact stack scrolls independently of the chat list. No metadata is fetched from linked sites. External opening accepts a stored link ID through trusted, validated IPC and revalidates the address in main before handing it to the default browser.

`PRAGMA user_version` tracks schema migrations. Existing databases are checkpointed/backed up before migration. Databases from newer app versions are rejected instead of reset. Demo mode uses separate storage and inboxes.

The former Python bridge and StatusSnapshot wire schema are not the desktop API. The app exposes only its preload IPC methods, validated in Electron's main process. Its local HTTP listener accepts authenticated hook observations only; it has no agent-control, cloud, or Jira API.
