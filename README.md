# Agent Control Deck

A local desktop app for monitoring Codex, Claude Code, and Cursor conversations across projects. Name chats, add notes, attach Jira references, and see their last reported activity. Opt in per source to answer Claude Code questions and Claude Code/Codex permission requests. The app does not submit follow-up prompts, launch chats, or control processes.

## Run the desktop app

Requires **Node.js 24+** and npm. Python is not needed for the desktop app.

```bash
npm ci
npm run dev
```

For a production build or a separate demo workspace:

```bash
npm run build
npm start
# Or:
npm run demo
```

The development demo command opens sample projects and chats in a separate SQLite database. Restart normally to return to your real workspace.

## What works

- Projects, manual chats, local chat names, and autosaved Markdown notes. Notes render inline in the details sidebar; click them or **Edit** to write, then use **Done** or Ctrl/Cmd+Enter to finish.
- Jira tickets sit beside the chat title. Click a populated ticket to open it in your default browser; use the pencil to edit its number or full URL inline. Enter saves and Escape cancels. Configure **Settings → Jira base URL** for ticket numbers; full URLs use their own address.
- Web links in assistant responses are collected before the preview is shortened. Compact category rows sit at the top of the project's chat list and the selected chat. **Settings → Link categories** lets you add an exact domain, optional path prefix, and any category name; unmatched links appear under **Other**. Project stacks combine duplicate URLs and provide shortcuts to their source chats, including archived chats. Moving a chat moves its links with it. Labels come from response Markdown or the URL; no page or ticket titles are downloaded.
- Each discovered repository has a permanent project; new chats join it automatically. Add a custom grouping with **Add a new project** at the end of the sidebar list or chat Project dropdown. Creating a project from the dropdown also adds the selected chat to it. Repo chats remain visible in their repository project when added to a custom project.
- Manual chats and providers without a workspace can exist under **No project**. Remove an optional grouping with **None** or **No project** in chat details.
- Search across names, notes, previews, project names, and Jira keys; filter by provider/state and browse the archive. Quick filters highlight running chats, chats needing input, and finished turns. A finished turn is an idle observation, not a claim that the work is complete.
- Archive/restore without losing history. Incoming events never overwrite local names, notes, references, project assignments, or archive state.
- Separate Codex, Claude Code, and Cursor hook adapters; ended sessions remain available.
- Recent activity (100 entries per chat), Markdown previews (500 characters), and last-observed timestamps. A completed turn means idle, not completed work. Preview links and images are displayed without navigation or remote loading.
- Source setup, diagnostic events, pause/resume, and workspace aliases to group Windows/WSL paths into one project.
- Optional live responses: permissions open in Spotlight with **Allow once**, **Deny**, and **Keep waiting**; Claude questions appear in the right dock across Today, Workspace, Sources, and Settings. Successful responses dismiss immediately with brief feedback. Failed delivery keeps the request and draft for retry.

The blue Operations workspace keeps projects on the left, compact chat records in the center, and the selected chat’s notes, ticket, and activity in the right sidebar. Chat name, project assignment, project renaming, and Archive/Restore are visible near the top of chat details. Every project name is editable, including repository labels carried over from older versions. New chats default to their repository project; accessible local Git worktrees share the parent repository's project. Moving a chat with the Project selector replaces its membership, including choosing No project. Names, assignments, and archives survive provider updates and restarts.

Use the flag beside a project in the left sidebar to mark it as priority; the pencil renames any project. Active chats in priority projects get a single red line along the left edge when they need input, report an error, finish a turn, or end a session. Hover over a marked chat to see the attention reason. The project's red lamp remains visible across chat filters, and its tooltip shows the number of chats needing attention. Unfinished or uncertain subagent work does not count as completed work. Priority follows the chat's current project, survives restarts, and clears from a chat when it resumes, is archived, or moves out of that project. Remove the flag to stop marking that project's chats.

An orange lamp appears on the Windows taskbar icon or macOS Dock icon while any open, unarchived chat reports **Needs input**. It clears when those chats resume, end, or are archived, regardless of list filters or window focus. The indicator reflects the last reported event. The app-rendered, draggable title bar integrates navigation. macOS keeps its traffic lights and system menu; Windows uses native window buttons without a separate title or menu bar.

## Connect live sources

Open **Settings → Sources → Add source**. Choose the provider and native or WSL environment. The app generates an authenticated HTTP hook configuration under its local data directory. Merge it into the provider's user settings, preserving unrelated settings/hooks and replacing the deck's old entries. Provider configuration is never edited automatically.

Native Claude Code uses HTTP hooks directly. WSL sources configured by the Windows deck use command hooks that invoke Windows `curl.exe`, keeping HTTP on the Windows side. Cursor and Codex also use command hooks that POST stdin with curl. No PowerShell or Bash collector scripts, separate Node installation, or Python are required.

To answer in the deck, select a Claude Code or Codex source and enable **Answer questions and permissions in the deck** (Codex: **Answer permissions in the deck**). Merge the regenerated hook fragment and review/trust the new Codex hooks. Existing sources remain observation-only until you opt in. Requests wait up to five minutes and then return to the agent's own interface; disabling responses also returns pending requests. **Keep waiting** dismisses Spotlight while the alert stays available. Codex questions remain in Codex, and Claude network sandbox permissions may still require its native interface. See [live responses](docs/desktop-integrations.md#live-permissions-and-questions) for coverage and delivery limits.

Subagent start/stop hooks keep background work visible after the main turn finishes: **Main turn finished · 2 subagents working**. These chats remain in Running until the observed workers finish; missing identities or observations older than five minutes show an uncertain status. Merge the latest configuration from Sources for existing installations, and review/trust new Codex hooks. See [subagent observations](docs/desktop-integrations.md#main-turns-and-subagent-observations) for provider differences and event coverage.

Claude's existing Stop/SubagentStop hooks also expose background monitors and scheduled checks. The deck shows **Monitoring · waiting for next check** between turns, with a separate Monitoring filter/count and observation details. No hook configuration changes are needed when these events already forward their complete payloads. Detection requires a Claude version that reports these fields; Codex/Cursor monitoring is not inferred. See [background monitoring](docs/desktop-integrations.md#background-monitoring-and-scheduled-checks) for freshness and snapshot limits.

For Claude Code in WSL, run the **Windows app**, create a WSL source per distro, and configure Claude inside that distro. The receiver defaults to `http://127.0.0.1:43821`. WSL hooks launch `"/mnt/c/Windows/System32/curl.exe"` through Windows executable interoperability and POST to Windows localhost, without requiring Windows directories on the Linux PATH. This route needs no WSL host-IP, mirrored-networking configuration, or inbound firewall exception. Windows interoperability must be enabled. Adjust the executable path in your hook commands if the Windows drive or WSL mount root differs. See [WSL setup and diagnostics](docs/desktop-integrations.md#wsl-networking).

Keep the deck running while using your agents. New and existing/resumed chats appear on their next submitted prompt; merely opening or closing an unused chat does not add it. Historical conversations are not scanned. Events sent while the deck is closed are not captured. Accepted observation events are queued on disk before ingestion; pause/resume and storage retries retain that queue. Live permission and question requests remain bound to their current hook connection and are never replayed after restart.

Command hooks finish quietly and successfully when the deck is unavailable, without interrupting the agent. The Sources diagnostic command still reports delivery failures so you can test the connection. Native Claude HTTP hooks allow execution to continue on connection failure, but Claude may display a hook error notice.

**Send diagnostic event** checks local inbox ingestion only. The **Settings → Sources** section also provides an HTTP test command to run in the provider environment. Submit a real prompt in an existing chat to verify the complete hook installation.

## Daily planning

**Today** is the main workspace: plan a dated card with Coding, Agentic, and Other sections, create or continue tasks, and keep their notes, tickets, links, and observed chats together. Open linked chats inline to see the latest question, approval request, prompt, and response. Import a pasted YAML/Markdown transcription or upload a file, review it beside the previous card, and save an optional evening wrap-up. **Repositories** provides observed chat history grouped by detected repository. See [daily planning](docs/daily-planning.md) for the workflow and card format.

## Local storage

SQLite databases live under Electron’s OS application-data directory, with separate `workspace/` and `demo/` subdirectories. Jira settings are saved separately in each database. The exact active path appears in the app footer. Hook files stay local. There is no cloud sync, telemetry, or Jira API access.

Optional **Settings → AI chat matching** uses OpenRouter or direct Amazon Bedrock to link today's chats to
tasks. Saving a key does not enable matching; the checkbox controls sending bounded
chat/task context to the selected model. Keys use OS-backed encryption and never
appear in snapshots or the database. See [automatic chat links](docs/daily-planning.md#optional-automatic-chat-links).

Local CPU matching keeps startup and inference diagnostics in `local-matching/worker.log` beneath the active data directory. The log is capped at 4 MiB and replaced when a worker starts; exception details can include chat input, so review it before sharing. UI and exported errors stay generic and point to the log.

The app backs up an existing database before schema migrations. For a manual backup, quit the app and copy the displayed data directory. Keep backups private: they contain your notes and previews.

## Checks and packaging

For the standalone, synthetic chat-to-task AI experiment, run `npm run test:matching`
and `npm run eval:matching`. See [matching evaluation](docs/chat-task-matching-eval.md)
for adding an OpenRouter key and explicitly enabling live requests.

```bash
npx playwright install chromium --only-shell  # once per machine, for headless UI tests
npm run typecheck
npm test                 # storage, provider, and HTTP tests; Electron's Node runtime only, no windows
npm run test:ui          # builds and tests the renderer in headless Chromium, including database restarts
npm run check            # routine desktop checks; no visible windows
npm run test:electron    # opt-in Electron startup, IPC isolation, native lamps and window controls
npm run check:all        # routine checks plus the windowed Electron suite
npm run package          # unpacked app in release/
npm run test:packaged    # run the small Electron suite against the built application bundle
npm run dist             # platform ZIP in release/
```

Routine UI tests use the real SQLite store, HTTP hooks, durable inboxes and workspace commands behind a test-only adapter for `window.deck`; they do not validate Electron preload isolation or OS window behavior. Clipboard writes are validated and external-browser requests are captured in the test adapter. The explicit Electron suite checks startup, preload/IPC isolation, restart persistence, native input lamps and window controls. Routine CI runs the headless suite on macOS and Windows; the packaging workflow runs the small packaged Electron suite.

Build on the target OS. CI is configured for macOS and Windows; real workplace provider/WSL validation still needs to be done there. Distribution builds are unsigned. Managed computers may require IT approval to run the app or allow user-defined hooks.

CI runs **Desktop checks** (`npm run check`) on pull request updates and pushes to `main`. Feature-branch pushes do not also start a duplicate run, and newer updates cancel superseded runs for the same PR or branch.

**Packaged app checks** runs on macOS and Windows when dependency manifests, packaging/build configuration, the packaged-test runner or its Electron tests change, and on `v*` release tags. Before a release, use Actions > Packaged app checks > Run workflow to validate the current build; enable `upload_packaged_builds` there when downloads are needed. Downloads are retained for three days. **Bridge reference checks** runs only for changes under `bridge/` or `schema/`, changes to `Makefile` or its workflow, or a manual run. Keep the path-filtered packaging and bridge workflows optional in branch protection; the always-running desktop checks can remain required.

The packaging tool's `@electron/get` dependency is overridden to v5 to avoid its older vulnerable HTTP cache dependency; Node 24 supports that downloader. The lockfile pins the tested dependency graph.

## Repository

- `src/main/`: SQLite, hook adapters/inboxes, HTTP reception/configuration, and Electron lifecycle.
- `src/preload/`: narrow validated IPC interface; the renderer has no Node access.
- `src/renderer/`: React workspace and source setup UI.
- `src/shared/`: types and input validation.
- `tests/`: persistence/integration tests and desktop UI automation.
- [bridge/](bridge/): retained Python migration reference; independent of the desktop runtime.
- [schema/](schema/): legacy StatusSnapshot v1 fixtures and contract, unchanged by the desktop model.

The reference bridge still runs with `make bridge-install && make bridge-serve`. `make check` checks both desktop and bridge; `npm run check` checks only the desktop.

Hardware source is preserved at tag `hardware-final-2026-10-04`. Firmware, simulator, and BLE dependencies are retired. The separate LilyGo checkout is untouched.
