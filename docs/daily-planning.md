# Daily planning trial

Open **Today** to plan from a daily card. Each entry is a plan item: an area of attention such as a product, research topic, document review, or conversation. You can keep entries broad.

- **Coding**: coding work with AI.
- **Agentic**: work delegated to AI.
- **Other**: work where most of the effort is yours, including reviewing a document, asking someone about something, and following up.

Projects provide optional broader context. Select an item and assign a project yourself, or leave it unassigned. Link existing chats from the item's details. These links do not change the chats' project assignments, and one chat may provide context for several plan items. Chat activity remains observational; an agent finishing does not mark your work complete.

**Mark worked on** records attention on that day. **Carry forward** schedules the same item on another day, retaining notes, project context, and linked chats. Each day's category and worked-on mark remain separate. Removing an item from a day retains its context in **All plan items**, where it can be scheduled again.

## Importing a card

Photograph your card and have your existing OCR tool transcribe it into the format below. The deck imports Markdown, rather than processing photographs itself.

```markdown
---
date: 2026-10-08
---

## Coding
- Agent Control Deck

## Agentic
- Research deployment options

## Other
- Review design document
- Ask team about deployment
```

Use one date and flat bullets under the three headings. A `# YYYY-MM-DD` title may replace the date frontmatter. Empty categories are allowed. Checkbox bullets are accepted, but their checkmarks do not imply progress. See [the sample card](examples/daily-card.md).

Select **Import card** to choose a Markdown file or paste a transcription. Alternatively, save `.md` or `.markdown` files into the folder shown in **Plan inbox**; the deck checks this folder while running. It is separate from the provider event inbox.

Review the wording before importing. For each entry, explicitly choose an existing item to continue its notes and chats, or create a new item. Matching names never automatically create relationships. Newly created items have no project or chat links. Reimporting identical Markdown has no effect; an edited card is a new import and needs review again.

Original transcriptions remain available through **View card**. Inbox files stay on disk after import; you can move them out yourself. The inbox scans the first 50 filenames and displays up to 20 pending files at once. Files are limited to 100,000 bytes; symlinks and nonregular files are rejected.

## Trying it safely

Run `npm run build` followed by `npm run demo`, then select **Today**. Demo plans use separate storage and include human-led review and conversation examples. To plan with your own observed chats, use **Leave demo** and **Today**. Existing databases are backed up before the planning schema migration.

Notes, project links, chat links, day placements, and import sources persist locally. This trial does not send instructions to agents or launch chats.
