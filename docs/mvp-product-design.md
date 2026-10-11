# Desktop product direction

## Goal

Provide one local workspace for monitoring agent conversations across projects, with persistent names, notes, and manual Jira ticket references. The intended first desktop release supports macOS and Windows, including native Windows Cursor and Claude Code in WSL.

The app observes agents and optionally answers live permission requests and Claude Code questions through documented hooks. Responses require a per-source opt-in and an explicit user action. It does not inject follow-up prompts, launch/resume sessions, or terminate work.

## Current implementation

Electron + TypeScript + React provides a basic three-pane workspace with SQLite persistence. Projects contain manual and live chats, with local names, notes, Jira references, archive/restore, search, and filters. A separate demo database contains realistic sample work.

Documented Claude Code and Cursor hooks feed atomic local inboxes. The main process validates events, deduplicates them, and separates user-owned fields from provider observations. Ended chats are retained; turn completion reports idle. Source setup includes native macOS/Windows collectors, WSL path translation, diagnostics, and project aliases.

Preview text is limited to 500 characters and activity to 100 entries per chat. Live requests display their tool input only while the synchronous hook is waiting; permission requests use Spotlight and questions use the right dock. The app reads no full transcripts or reasoning traces. Jira references remain manual.

The Python bridge remains an independent migration reference with its original API behavior and limits. Hardware source is preserved at Git tag `hardware-final-2026-10-04`; the external LilyGo checkout is untouched.

See [desktop-integrations.md](desktop-integrations.md) for interfaces, setup, and failure behavior.

## UX after the foundation

Begin with projects, a searchable/filterable chat list, and a selected-chat detail pane. Once persistence and live updates work, refine scanning, stable selection, keyboard navigation, notes, and save feedback using realistic multi-project scenarios.

## Deferred

Jira authentication/synchronization, a separate task hierarchy, agent controls, historical chat scraping, cross-device sync, and cloud/multi-tenant services. The current bridge will be retired after its useful behavior and fixtures have been carried into TypeScript.

See [pr-plan.md](pr-plan.md) for delivery stages, [status-schema.md](status-schema.md) for the retained contract, and [../bridge/README.md](../bridge/README.md) for the working bridge.
