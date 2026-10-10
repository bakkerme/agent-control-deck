# Daily task workspace

Today is the landing screen. Each dated card has Coding, Agentic, and Other sections. Use broad tasks that describe where you want to put your attention. Agent activity stays observational: an agent finishing never marks a task done.

## Morning and evening

Review Slack, reminders, and both sides of yesterday's physical card. Plan a fresh card, photograph it, and use Claude or your preferred transcription tool to produce YAML or Markdown. Paste that text into **Import card**, or upload a `.md`, `.markdown`, `.yaml`, or `.yml` file. The deck does not process photos or call an AI matching service.

The import review shows a previous saved card's plan and wrap-up beside the proposed new entries. Edit the titles and explicitly choose **New task** or an existing task for each entry. Continuing preserves its notes, tickets, links, and chats; earlier dated titles remain unchanged. Two entries on one card cannot continue the same task. Matching names never automatically connect tasks. **Back to Today** pauses the review, and **Resume card review** restores it after restart. Identical source text is imported only once; edited text requires review again.

At the end of the day, use **Mark as done** for work you consider complete on that day. **Wrap up day** shows the saved card with optional Markdown notes on its back. Click notes to edit, then Save or Cancel. Your physical card can remain the source for wrap-up instead.

## Tasks and context

**+ Add task** opens an inline panel. Search at the top shows up to three existing tasks; choose one and its title and category for this card. The separate new-task form below accepts a name, category, optional ticket, and Markdown notes. Searching does not replace that draft.

Select a task to edit its context inline. Hover its name for the rename pencil. Click rendered notes to edit their Markdown source; Save and Cancel appear only while editing. Unfinished notes, new-task forms, ticket/link editors, and card reviews persist as drafts locally.

- **Tickets:** plus links a ticket key or full HTTP/S URL. Click the ticket to open it; hover or focus for edit and ×. Ticket keys use the Jira base URL in Settings.
- **Tracked links:** includes URLs detected from linked chat responses and your own URLs. Each category has one label beside its links. Click the label to rename it, or choose a new category in the link editor. Hover or focus a link for edit and ×; removed URLs can be restored from **Removed links**.
- **Linked chats:** plus chooses existing observed chats. Click a chat to expand its most recent observed round inline, including the exact request when the provider supplies one. Requests must be answered in the originating agent UI. **View chat history** opens the repository viewer; **Back to Today** retains your task context. × detaches a chat without deleting it.

Drag cards to reorder or change category. With a card focused, Alt+Up/Down reorders and Alt+Left/Right changes category. **Move to another day** moves that placement and offers next, three, or five business days (Monday–Friday), plus any calendar date. It retains the task context and daily annotation, and resets that placement's done mark. To keep an earlier placement and add a later one, use **+ Add task** and continue the existing task.

Removing a task from one day leaves its other days intact. Removing its final card asks for confirmation and removes its saved task context; linked chats and external tickets/URLs remain untouched. **Undo** restores the last planning change, including final removal, until another planning change replaces it. It never rewinds provider observations.

## Card formats

```yaml
date: 2026-10-12
coding:
  - name: Card import improvements
    tickets:
      - key: DECK-42
        status: backlog
        note: Review validation
    note: Check explicit task connections
agentic:
  - Review agent workflows
other:
  - Ask team about deployment
```

A YAML card has one `date` and any of the `coding`, `agentic`, and `other` lists (case-insensitive). Each item is a name or a mapping containing `name` (up to 200 characters), `tickets` (keys or mappings with `key`, `status`, `note`), and `note` (up to 2,000 characters). Legacy `related` ticket arrays are accepted and placed in the task's Tickets section. Unknown fields and YAML aliases are rejected. Cards are limited to 200 tasks and 100,000 characters. Fenced YAML is accepted.

Markdown uses a date heading, category headings, and task bullets. Indented lines annotate the preceding task:

```markdown
# 2026-10-12

## Coding
- Card import improvements
  Check explicit task connections.

## Other
- Ask team about deployment
```

A date in YAML frontmatter is also accepted. Original transcriptions remain available on the daily card. A new task's shared notes start with its annotation; continuing adds the new daily annotation without replacing shared notes or existing ticket details.

## Storage and demo

All planning data stays in the local database. Existing databases are backed up before migration. Existing custom project records and user-owned chat fields are retained, while Today no longer assigns projects and Repositories groups chats by detected repository.

Run `npm run build` followed by `npm run demo` to use separate sample storage. Use **Leave demo** to return to your own workspace. There is no planning inbox; paste or upload a transcription directly. Provider event inboxes continue to operate independently.
