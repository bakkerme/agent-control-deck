# Daily planning trial

Open **Today** to plan from a daily card. Each entry is a plan item: an area of attention such as a product, research topic, document review, or conversation. You can keep entries broad.

- **Coding**: coding work with AI.
- **Agentic**: work delegated to AI.
- **Other**: work where most of the effort is yours, including reviewing a document, asking someone about something, and following up.

Projects provide optional broader context. Select an item and assign a project yourself, or leave it unassigned. Link existing chats from the item's details. These links do not change the chats' project assignments, and one chat may provide context for several plan items. Chat activity remains observational; an agent finishing does not mark your work complete.

**Mark worked on** records attention on that day. **Reschedule** moves the item to another day and removes it from the current day, retaining notes, project context, and linked chats; the current day's worked-on mark is not carried over. Each day's category and worked-on mark remain separate. Removing an item from a day retains its context in **All plan items**, where it can be scheduled again.

## Importing a card

Photograph your card and have your existing OCR tool transcribe it into the YAML format below. The deck imports YAML, rather than processing photographs itself.

```yaml
date: 2026-10-09

coding:
  - name: Installer signing
    tickets:
      - key: DECK-101
        status: backlog
        note: Support for the new installer
  - name: Test the staging lab
    note: No ticket yet
    related: [DECK-102, DECK-103]

agentic:
  - Research deployment options

other:
  - name: Update runbook
    note: Draft pending
    related: [CHG-201]
  - Ask team about deployment
```

A card has one `date` and any of the `coding`, `agentic`, and `other` lists (case-insensitive, and empty lists are allowed). An item is either a plain name or a mapping with these fields:

| Field | Meaning |
| --- | --- |
| `name` | Required; up to 200 characters. |
| `tickets` | The item's own Jira tickets. Each is a key (`DECK-101`) or a mapping of `key`, optional `status`, and optional `note` for that ticket. |
| `related` | Adjacent tickets in the same shape, kept apart from `tickets`. |
| `note` | An annotation about the item as a whole. |

Unknown fields and sections are errors instead of being ignored, so a typo is reported at review time. An item with no ticket simply omits `tickets`. YAML aliases are not supported. See [the sample card](examples/daily-card.yaml).

Select **Import card** to choose a YAML file or paste a transcription. Alternatively, save `.yaml` or `.yml` files into the folder shown in **Plan inbox**; the deck checks this folder while running. It is separate from the provider event inbox.

Review the wording before importing. For each entry, explicitly choose an existing item to continue its notes and chats, or create a new item. Matching names never automatically create relationships. A newly created item starts with no project or chat links, and its notes are seeded with the card's annotation and ticket lists. Continuing an existing item never overwrites its notes. Reimporting an identical card has no effect; an edited card is a new import and needs review again.

Original transcriptions remain available through **View card**. Inbox files stay on disk after import; you can move them out yourself. The inbox scans the first 50 filenames and displays up to 20 pending files at once. Files are limited to 100,000 bytes; symlinks and nonregular files are rejected. Markdown cards from earlier versions are no longer imported; their stored originals remain viewable.

## Trying it safely

Run `npm run build` followed by `npm run demo`, then select **Today**. Demo plans use separate storage and include human-led review and conversation examples. To plan with your own observed chats, use **Leave demo** and **Today**. Existing databases are backed up before the planning schema migration.

Notes, project links, chat links, day placements, and import sources persist locally. This trial does not send instructions to agents or launch chats.
