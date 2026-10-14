# Claude Code repository guidance

Follow the repository instructions in AGENTS.md.

Keep the commit confidentiality hook enabled (`npm run guard:install -- --reviewer desktop`
on Claude Desktop machines). Before staging, replace employer/customer examples, logs,
internal identifiers and enterprise-specific configuration with synthetic data.
Fix blocked findings rather than bypassing the hook. See docs/commit-confidentiality.md.

For Desktop commits, stage in a separate call and use a literal git commit -m.
The native verifier reviews the full staged bundle and records an exact approval.
Never call --desktop-approve yourself merely to get around a blocked commit.
