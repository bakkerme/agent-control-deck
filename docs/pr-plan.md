# Desktop transition status

## Implemented

- Hardware retirement, with source recovery at `hardware-final-2026-10-04`.
- Electron + TypeScript + React shell and SQLite persistence with migration backups.
- Projects, manual/live chats, local names, autosaved notes, Jira references, archive/restore, search, and filters.
- Separate documented-hook adapters for Claude Code and Cursor, authenticated HTTP delivery with atomic inbox ingestion, generated native/WSL setup, diagnostics, and workspace aliases.
- Isolated sample workspace and lifecycle transitions.
- Storage/provider/HTTP forwarding tests, Electron UI automation, and macOS/Windows CI packaging configuration.

The UI uses a basic three-pane layout. Python remains a reference implementation; the desktop does not depend on it.

## Next: UX refinement

Use the working app and representative scenarios to refine scanning, attention cues, project orientation, notes, stable selection, keyboard navigation, and layout. Preserve the data/integration invariants while iterating visually.

## Work-machine validation

Run the Windows build and validate native Cursor plus Claude Code in WSL with real hooks. Verify HTTP hook support, curl forwarding, Windows curl interoperability from WSL and receiver reachability, workspace aliases, and provider versions. Fixture tests and a configured CI job do not prove workplace compatibility.

## Deferred

Separate task hierarchy, Jira synchronization/authentication, agent control or launch/resume, historical chat scraping, cross-device sync, signing/notarization, and automatic updates. Retire the Python reference in a separate cleanup when it is no longer needed.
