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

- Projects, manual chats, local chat names, autosaved notes, and Jira keys/URLs.
- Chats can exist without a project. Choose **No project** in a chat’s Project selector to remove its assignment; use the sidebar to find unassigned chats.
- Search across names, notes, previews, project names, and Jira keys; filter by provider/state and browse the archive.
- Archive/restore without losing history. Incoming events never overwrite local names, notes, references, project assignments, or archive state.
- Separate Codex, Claude Code, and Cursor hook adapters; ended sessions remain available.
- Recent activity (100 entries per chat), Markdown previews (500 characters), and last-observed timestamps. A completed turn means idle, not completed work. Preview links and images are displayed without navigation or remote loading.
- Source setup, diagnostic events, pause/resume, and workspace aliases to group Windows/WSL paths into one project.

The three-pane workspace uses an app-rendered, draggable title bar with integrated navigation. macOS keeps its traffic lights and system menu; Windows uses native window buttons without a separate title or menu bar. Broader visual polish and task/Jira workflows come later.

## Connect live sources

Open **Sources → Add source**. Choose the provider and native or WSL environment. The app generates an authenticated HTTP hook configuration under its local data directory. Merge it into the provider's user settings, preserving unrelated settings/hooks and replacing the deck's old entries. Provider configuration is never edited automatically.

Native Claude Code uses HTTP hooks directly. WSL sources configured by the Windows deck use command hooks that invoke Windows `curl.exe`, keeping HTTP on the Windows side. Cursor and Codex also use command hooks that POST stdin with curl. No PowerShell or Bash collector scripts, separate Node installation, or Python are required.

For Claude Code in WSL, run the **Windows app**, create a WSL source per distro, and configure Claude inside that distro. The receiver defaults to `http://127.0.0.1:43821`. WSL hooks launch `curl.exe` through Windows executable interoperability and POST to Windows localhost. This route needs no WSL host-IP, mirrored-networking configuration, or inbound firewall exception. Windows interoperability must be enabled and `curl.exe` available on the WSL PATH. See [WSL setup and diagnostics](docs/desktop-integrations.md#wsl-networking).

Keep the deck running while using your agents. New and existing/resumed chats appear on their next submitted prompt; merely opening or closing an unused chat does not add it. Historical conversations are not scanned. Events sent while the deck is closed are not captured. Accepted requests are queued on disk before ingestion; pause/resume and storage retries retain that queue.

**Send diagnostic event** checks local inbox ingestion only. The Sources page also provides an HTTP test command to run in the provider environment. Submit a real prompt in an existing chat to verify the complete hook installation.

## Local storage

SQLite databases live under Electron’s OS application-data directory, with separate `workspace/` and `demo/` subdirectories. The exact active path appears in the app footer. Hook files stay local. There is no cloud sync, telemetry, or Jira API access.

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
