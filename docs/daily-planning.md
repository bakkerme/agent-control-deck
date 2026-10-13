# Daily task workspace

Today is the landing screen. Each dated card has Coding, Agentic, and Other sections. Use broad tasks that describe where you want to put your attention. Agent activity stays observational: an agent finishing never marks a task done.

## Morning and evening

Review Slack, reminders, and both sides of yesterday's physical card. Plan a fresh card, photograph it, and use Claude or your preferred transcription tool to produce YAML or Markdown. Paste that text into **Import card**, or upload a `.md`, `.markdown`, `.yaml`, or `.yml` file. The deck does not process photos. Optional AI chat matching is configured separately in Settings.

**Import card** sits beside the Today filters. **New**, directly below those filters and above search, shows unarchived chats created or observed through agent events today that are not linked to a task on any card. It uses local calendar dates and agent event timestamps; editing a chat's name or notes does not count as agent activity. The newest activity appears first, with three rows initially and **Show more** for the rest. Select a chat to use the same chat tools as Repositories: open detected links and tickets, edit its name and Markdown notes, review its latest round, activity and source observations, or archive it. Archived chats leave New and can be restored from **Repositories → Archived chats**. A task is optional. You can also link the chat to any existing task, or create a task on the selected day's card with that chat linked. Linking removes it from New without marking the task done. Chat edits are saved before switching chats, linking, archiving, or leaving Today; a failed save keeps the editor open for retry.

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

## Optional automatic chat links

For CPU-only matching on this computer, choose **Local CPU model** in Settings,
download Kai (or Vela), test it, then enable automatic links. No API key or GPU is
required. See the [Windows-first local MVP guide](local-matching-mvp.md) for setup,
offline operation and local performance/feedback exports. The controls below
describe the existing cloud alternatives.

In **Settings → AI chat matching**, choose **OpenRouter** or **Amazon Bedrock (direct)**,
enter that service's API key and **Save AI settings**.
**Test connection** sends a synthetic example. Then select **Enable automatic chat
links** and save again. Matching is off by default; saving a key alone does not
send your chats. Luna is pinned to OpenRouter's Bedrock endpoint by default, with
no fallback. Model and routing can be changed under the advanced controls.

For direct Bedrock, use a **Bedrock API key / bearer token**, not an AWS access key
ID. The default is Bedrock Runtime in `ap-southeast-2` (Sydney), using the global
inference profile `global.openai.gpt-6-luna`. Change the AWS region and model/profile
under **Model and routing** if your account requires another region or profile.
For Luna, Runtime requires a system inference profile rather than the base model ID;
the global profile can process requests outside Australia. The US profile
`us.openai.gpt-6-luna` is available only from its supported North American source
regions, not Sydney. The key's IAM identity needs permission to invoke
the selected profile and the account's default project. **Test connection** checks
your actual key, access, endpoint and JSON output contract with a synthetic example.
If it fails, the test displays a bounded provider explanation and AWS request ID
when available, with credentials redacted. Automatic matching suppresses provider
error messages because they can echo real chat content.
Requests go directly to AWS and never fall back to OpenRouter. AWS profile/SSO
authentication and automatic bearer-token refresh are not implemented; replace an
expired token in Settings. See [AWS's Luna model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-luna.html)
and [Bedrock API key usage](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html).

Each service retains its own model settings and encrypted key. Changing the service turns
the matching checkbox off; save the selection, test it and explicitly re-enable.

When enabled, the app considers unarchived provider chats observed today that have
an observed prompt or response, against today's plan items. It sends bounded chat
titles, repository names, the first observed user prompt and task titles, notes, daily
annotations and ticket keys. URLs and whitespace are compacted in a matching-only
copy before limits are applied; assistant responses and later turns are omitted.
It does not scrape transcripts, include filesystem
paths, control agents, or infer task completion. At most 50 tasks are considered;
larger cards pause matching rather than silently omit candidates.

Clear matches add an ordinary linked-chat row with a small sparkle. Uncertain
matches remain unassigned. Existing links never move automatically. × removes the
link and durably dismisses that chat/task pair; manually linking it again clears
the dismissal. Undo restores the link and its provenance. Background matching
preserves the last user Undo instead of replacing it.

Cloud requests run one at a time, at most once every 12 seconds. An unchanged assessment
is cached across restart, including an abstention. Changed opening evidence, titles or
changed task context can trigger another assessment. Responses are discarded if
their context changed while waiting. Local transient failures receive two delayed
background retries with persistent limits and a shared worker failure budget; exhausted
or invalid requests quietly give up. Cloud errors pause matching; save AI settings or
successfully test the connection to retry. Matching failures never stop hook
ingestion. Automatic matching is paused in demo, and demo settings and credentials
remain separate.

The key is write-only from Settings and encrypted by Electron's asynchronous
`safeStorage` API. macOS uses Keychain; Windows uses DPAPI. Windows protects against
other OS users, but other software running as your account may still decrypt data.
No plaintext fallback is permitted; Linux's `basic_text` backend is refused.
Ciphertext lives in `openrouter-key.enc` and `bedrock-key.enc` beside the workspace database with owner-only
permissions where supported. The plaintext key is never stored in SQLite,
snapshots, drafts or reports. **Remove saved key** turns matching off and deletes
that service's ciphertext. The other service's credential is retained. A copied credential file may not unlock on a different machine or
OS account. Unsigned macOS builds may prompt for Keychain access after updates.
See [Electron's secure storage documentation](https://www.electronjs.org/docs/latest/api/safe-storage).

## Storage and demo

All planning data stays in the local database. Existing databases are backed up before migration. Existing custom project records and user-owned chat fields are retained, while Today no longer assigns projects and Repositories groups chats by detected repository.

Run `npm run build` followed by `npm run demo` to use separate sample storage. Restart normally to return to your own workspace. There is no planning inbox; paste or upload a transcription directly. Provider event inboxes continue to operate independently.
