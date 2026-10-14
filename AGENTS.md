# AGENTS.md — Agent Control Deck

## Product

A local Electron + TypeScript + React desktop monitor for agent chats across projects. Support macOS and Windows, including native Windows Cursor and Claude Code in WSL. The UI is functional but intentionally basic; refine it independently of the storage/integration layer.

Read-only toward agents: do not add approvals, prompt injection, process control, or chat launching without an explicit product request. Names, notes, Jira references, project assignments, and archives belong to the user and must survive provider updates.

## Desktop architecture

- `src/main/`: SQLite (`better-sqlite3`), migrations, provider adapters, authenticated HTTP reception, durable file inboxes, generated hook configuration, and Electron lifecycle.
- `src/preload/`: narrow typed IPC. Validate inputs and the sender in main; never expose arbitrary filesystem or shell access.
- `src/renderer/`: React UI. Keep Node disabled, context isolation and sandbox enabled, and render provider content as text.
- `src/shared/`: types and Zod validation. Desktop contracts are independent of legacy StatusSnapshot.
- `tests/`: Node tests run through Electron to match SQLite's native ABI; Routine Playwright tests drive the built renderer in headless Chromium with the real workspace runtime. Electron window/IPC/native-control checks are a separate opt-in suite.

Use Node 24+ and npm; commit `package-lock.json`. `npm ci` installs Electron and rebuilds SQLite. `npm run dev` starts development, `npm run build && npm start` runs a production build, and `npm run demo` uses separate sample data after building.

## Invariants

- Use documented hooks only; no provider storage scraping. Keep hook forwarding fail-open and free of intervention decisions.
- Keep lifecycle separate from activity: a completed turn is idle; an ended session retains its chat. Show observation age instead of guessing process liveness.
- Ingest each event transactionally with deduplication. Preserve queued events on disk/database failure; bound payloads and displayed history.
- Scope external IDs and workspace paths to a source. Support Windows/WSL aliases without merging by folder basename.
- Keep demo storage isolated. Never reset a failed/newer database; preserve migration backups.
- Keep `node_modules/`, output, release artifacts, databases, virtual environments, secrets, and credentials out of Git.
- Review changes for employer/customer information before staging: replace real examples, transcripts, internal identifiers and organization-specific configuration with synthetic equivalents. Keep the local commit confidentiality hook enabled (`npm run guard:install`); fix blocked findings rather than bypassing the hook.

## Verification

Run `npm run check` for desktop changes (type checking, native storage/provider/HTTP tests, and headless renderer tests; no visible windows). Run `npm run test:electron` when changing Electron lifecycle, preload/IPC security, or native window controls; this opt-in suite opens windows. `npm run check:all` includes both suites. Run `npm run package` when changing native dependencies or packaging. Build on the target OS; do not claim Windows/WSL or real provider verification from macOS fixtures alone.

The packaging downloader override in package.json removes an old vulnerable cache dependency. Validate packaging and audit when changing it.

## Python reference and hardware history

The bridge remains a migration reference, independent of the desktop. Keep its API behavior and v1 field limits unchanged unless explicitly migrating it. Use `make bridge-test schema-check` for changes there and commit `bridge/uv.lock` with dependencies. Loopback remains its default.

The hardware source is at tag `hardware-final-2026-10-04`. Do not restore firmware, simulator, BLE, or board dependencies. Leave the external LilyGo checkout untouched.

See README.md, docs/desktop-integrations.md, and docs/pr-plan.md for setup and scope.
