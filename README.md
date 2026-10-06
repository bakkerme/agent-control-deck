# Agent Control Deck

A local desktop app for monitoring Codex, Claude Code, and Cursor conversations across projects. Name chats, add notes, attach Jira references, and see their last reported activity. The app observes agents; it does not approve requests, inject prompts, or control sessions.

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

Use **Try demo** in the app to explore sample projects, a standalone chat, and lifecycle changes. Demo mode has a separate SQLite database; leaving it returns to your real workspace.

## What works

- Projects, manual chats, local chat names, and autosaved Markdown notes. Notes render inline in the details sidebar; click them or **Edit** to write, then use **Done** or Ctrl/Cmd+Enter to finish.
- Jira tickets sit beside the chat title. Click a populated ticket to open it in your default browser; use the pencil to edit its number or full URL inline. Enter saves and Escape cancels. Configure **Settings → Jira base URL** for ticket numbers; full URLs use their own address.
- Each discovered repository has a permanent project; new chats join it automatically. Add a custom grouping with **Add a new project** at the end of the sidebar list or chat Project dropdown. Creating a project from the dropdown also adds the selected chat to it. Repo chats remain visible in their repository project when added to a custom project.
- Manual chats and providers without a workspace can exist under **No project**. Remove an optional grouping with **None** or **No project** in chat details.
- Search across names, notes, previews, project names, and Jira keys; filter by provider/state and browse the archive. Quick filters highlight running chats, chats needing input, and finished turns. A finished turn is an idle observation, not a claim that the work is complete.
- Archive/restore without losing history. Incoming events never overwrite local names, notes, references, project assignments, or archive state.
- Separate Codex, Claude Code, and Cursor hook adapters; ended sessions remain available.
- Recent activity (100 entries per chat), Markdown previews (500 characters), and last-observed timestamps. A completed turn means idle, not completed work. Preview links and images are displayed without navigation or remote loading.
- Source setup, diagnostic events, pause/resume, and workspace aliases to group Windows/WSL paths into one project.

The blue Operations workspace keeps projects on the left, compact chat records in the center, and the selected chat’s notes, ticket, and activity in the right sidebar. Chat name, project assignment, project renaming, and Archive/Restore are visible near the top of chat details. Repository projects have permanent names and path mappings. Custom projects can represent any body of work and can be renamed for all associated chats. Names, assignments, and archives survive provider updates and restarts.

Use the flag beside a project in the left sidebar to mark it as priority; the pencil renames custom projects. Active chats in priority projects get a red lamp and highlighted row when they need input, report an error, finish a turn, or end a session. The project's red lamp remains visible across chat filters, and its tooltip shows the number of chats needing attention. Unfinished or uncertain subagent work does not count as completed work. Priority applies through either the repository or an additional custom project, survives restarts, and clears from a chat when it resumes or is archived. Remove the flag to stop highlighting that project's chats.

An orange lamp appears on the Windows taskbar icon or macOS Dock icon while any open, unarchived chat reports **Needs input**. It clears when those chats resume, end, or are archived, regardless of list filters or window focus. The indicator reflects the last reported event. The app-rendered, draggable title bar integrates navigation. macOS keeps its traffic lights and system menu; Windows uses native window buttons without a separate title or menu bar.

## Connect live sources

Open **Sources → Add source**. Choose the provider and native or WSL environment. The app generates an authenticated HTTP hook configuration under its local data directory. Merge it into the provider's user settings, preserving unrelated settings/hooks and replacing the deck's old entries. Provider configuration is never edited automatically.

Native Claude Code uses HTTP hooks directly. WSL sources configured by the Windows deck use command hooks that invoke Windows `curl.exe`, keeping HTTP on the Windows side. Cursor and Codex also use command hooks that POST stdin with curl. No PowerShell or Bash collector scripts, separate Node installation, or Python are required.

Subagent start/stop hooks keep background work visible after the main turn finishes: **Main turn finished · 2 subagents working**. These chats remain in Running until the observed workers finish; missing identities or observations older than five minutes show an uncertain status. Merge the latest configuration from Sources for existing installations, and review/trust new Codex hooks. See [subagent observations](docs/desktop-integrations.md#main-turns-and-subagent-observations) for provider differences and event coverage.

For Claude Code in WSL, run the **Windows app**, create a WSL source per distro, and configure Claude inside that distro. The receiver defaults to `http://127.0.0.1:43821`. WSL hooks launch `"/mnt/c/Windows/System32/curl.exe"` through Windows executable interoperability and POST to Windows localhost, without requiring Windows directories on the Linux PATH. This route needs no WSL host-IP, mirrored-networking configuration, or inbound firewall exception. Windows interoperability must be enabled. Adjust the executable path in your hook commands if the Windows drive or WSL mount root differs. See [WSL setup and diagnostics](docs/desktop-integrations.md#wsl-networking).

Keep the deck running while using your agents. New and existing/resumed chats appear on their next submitted prompt; merely opening or closing an unused chat does not add it. Historical conversations are not scanned. Events sent while the deck is closed are not captured. Accepted requests are queued on disk before ingestion; pause/resume and storage retries retain that queue.

Command hooks finish quietly and successfully when the deck is unavailable, without interrupting the agent. The Sources diagnostic command still reports delivery failures so you can test the connection. Native Claude HTTP hooks allow execution to continue on connection failure, but Claude may display a hook error notice.

**Send diagnostic event** checks local inbox ingestion only. The Sources page also provides an HTTP test command to run in the provider environment. Submit a real prompt in an existing chat to verify the complete hook installation.

## Local storage

SQLite databases live under Electron’s OS application-data directory, with separate `workspace/` and `demo/` subdirectories. Jira settings are saved separately in each database. The exact active path appears in the app footer. Hook files stay local. There is no cloud sync, telemetry, or Jira API access.

The app backs up an existing database before schema migrations. For a manual backup, quit the app and copy the displayed data directory. Keep backups private: they contain your notes and previews.

## Checks and packaging

```bash
npm run typecheck
npm test                 # storage, provider, and HTTP receiver/forwarding tests under Electron's Node runtime
npm run test:ui          # builds and drives the Electron UI, including restart persistence
npm run check            # all desktop checks
npm run package          # unpacked app in release/
npm run test:packaged    # drive the built application bundle
npm run dist             # platform ZIP in release/
```

Build on the target OS. CI is configured for macOS and Windows; real workplace provider/WSL validation still needs to be done there. Distribution builds are unsigned. Managed computers may require IT approval to run the app or allow user-defined hooks.

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
