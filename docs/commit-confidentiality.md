# Commit confidentiality review

Model review is required on work machines and enabled by default. The owner
explicitly permits personal/cloud tasks to commit, push and open pull requests
without model confidentiality review. This exception does not permit secrets,
employer/customer data or runtime artifacts in the repository.

## Explicit personal/cloud opt-out

For an owner-approved personal/cloud checkout, install the same Git gate with
model review explicitly off:

```sh
npm run guard:install -- --reviewer off
```

This writes only repository-local `commitGuard.reviewer=off`; it does not change
global Git settings. Linked worktrees share that local setting, so use a separate
clone or a task-scoped `COMMIT_GUARD_REVIEWER=off` environment override when other
worktrees need review. The installer removes only this guard's native Desktop
review hook, preserving unrelated hooks. Existing different Git commit hooks
still require manual integration; they are never overwritten.

The environment override affects the Git gate only. If the native Desktop
review hook was installed previously, it still runs in that Desktop session;
use the off installer and restart the Code session to remove that hook.

The Git gate still checks staged artifacts, content encoding, supported file
types and size limits. Known runtime/credential-file names remain rejected.
These deterministic checks are not a secret scanner or a model confidentiality
review: ordinary text can still contain secrets or private information. Output
explicitly says model review was **skipped**, never passed. Ordinary build/tests
remain required. No CLI, model account or Desktop approval is needed in off mode.

New cloud clones must opt in during setup after `npm ci`, using the install
command above (or install the gate and explicitly set the task environment
override). A setup script that currently installs a reviewer should change that
one command to `npm run guard:install -- --reviewer off` for approved cloud
checkouts. There is no automatic detection of cloud or generic `CI` variables.

Restore review using `npm run guard:install -- --reviewer desktop`, `codex` or
`claude`, and remove any task environment override. Missing reviewers, auth,
network access, invalid results and timeouts continue to block in enabled modes;
they never trigger the exception. Unknown reviewer values also block.

## Work-machine review

For Claude Code in the Windows Claude Desktop app, install the native session
review and Git gate:

```sh
npm run guard:install -- --reviewer desktop
```

This is also the default for `npm run guard:install`. It requires Node 24+ and
Git, but no standalone Claude or Codex CLI. Restart your Code session and
review/trust the added hooks. The installer merges the native hook into ignored
`.claude/settings.local.json`, preserving other hooks and permissions. It adds
`commit-msg` to Git's active hooks directory, preserving other Git hooks and
refusing to replace a different existing `commit-msg` hook. Install on each
machine/checkout where Git creates your commits.

Ask Claude in the Code chat to commit. Before its Git command executes, Claude's
native `PreToolUse` agent hook reviews the staged files and proposed message
through the existing Desktop session runtime. The native verifier uses general
knowledge plus the staged README, AGENTS and CLAUDE guidance. It checks complete
staged versions of changed text files, filenames and the diff. Unstaged edits
are excluded; removed lines supply context and removal of existing private data
is allowed. No employer keyword list is needed.

The review covers non-synthetic examples/fixtures/transcripts, logs, proprietary
business details/code, employee/customer information, internal projects/tickets,
enterprise endpoints and account/tenant IDs, SSO/proxy/registry/certificate
settings, and credentials. Generic public integration support and clearly
invented examples are allowed. Suspicious material with unclear provenance
blocks the tool call, with suggested synthetic replacements. The reviewer does
not automatically rewrite files or stage anything.

After a safe review, the verifier records a private approval under Git's data
directory. It contains only the reviewed tree ID, message hash and expiry.
Git's `commit-msg` hook independently checks that approval against the exact
staged tree and message. The approval expires after five minutes and is consumed
once. Missing, expired, mismatched or malformed approvals block the commit.
Staging or message changes require another review. Native hook timeouts or
errors cannot create an approval, so the Git gate still blocks.

Claude must stage in a separate tool call, then use a plain `git commit -m` with
a literal message. Combined staging/commit commands, automatic staging with
`-a`, pathspec commits and dynamic/message-file inputs are rejected because the
verifier cannot review their final content before they execute. Ask Claude to
split those operations and retry. A Commit button or a commit made outside
Claude's chat does not start the native review and will be blocked without an
appropriate approval. This route is for commits requested in the Code chat.

Known runtime logs, databases, credential-file extensions and non-example
environment files are rejected by the bundle generator and Git gate. Binary
files, symlinks, submodules, invalid UTF-8, files/diffs over 1 MiB or bundles over
2 MiB also block because this reviewer cannot inspect them completely.

The native hook uses Claude's documented `agent` hook type, which is experimental,
and the `if` filter for Git calls through Bash or PowerShell. Claude Desktop must
support these settings and permit the native verifier's bundle/approval commands.
Managed settings may restrict project hooks. This implementation's receipt,
installation and Git gate are tested locally; the actual native verifier has
not been exercised on a Windows Claude Desktop session. Confirm that a synthetic
commit shows the confidentiality review before relying on it on your machine.

The approval is an agent attestation, not cryptographic proof of model review.
The `--desktop-approve` helper must only be called by the verifier after reviewing
the complete bundle and message; simply issuing that command can create an
approval. Model judgments can miss information or follow malicious instructions
despite the prompt telling them to treat staged material as untrusted. These
controls prevent accidental use of stale review; they are not a security boundary
against a deliberate bypass. Review material stays with the provider already
used by the Desktop session; no separate account or API key is introduced.

For machines with a standalone CLI, the original separate reviewers remain
available:

```sh
npm run guard:install -- --reviewer codex
npm run guard:install -- --reviewer claude
```

These modes start a fresh signed-in CLI review during `commit-msg`, using an
isolated temporary directory and structured results. They do require their CLI
on PATH. Claude runs without tools, hooks, skills, MCP or session persistence;
Codex uses a read-only sandbox and ephemeral session without user configuration.
CLI errors, uncertainty, malformed results and the three-minute timeout block
commits. The installer removes its native Desktop hook when switching to a CLI
reviewer, preserving unrelated hooks.

The selection is local Git configuration (`commitGuard.reviewer`), overridden
by `COMMIT_GUARD_REVIEWER=desktop|claude|codex|off`; there is no automatic provider
fallback. `COMMIT_GUARD_MODEL` selects a model for CLI modes only.
`CODEX_COMMIT_GUARD_MODEL` also remains supported for Codex. To review the index
without committing in CLI modes, use `npm run guard:review`. Desktop mode obtains
its approval from the native session hook.

Git's `--no-verify` bypasses the Git gate; plumbing commands and disabled hooks
are outside its protection. It does not audit existing history or prevent a push
of an already-created commit. Keep the hooks enabled and fix blocked findings.
