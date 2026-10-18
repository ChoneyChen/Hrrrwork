# Security Policy

## Reporting

Please use GitHub's private security advisory flow to report a vulnerability. Do not include live Codex tokens, private thread contents, or account identifiers in a public issue.

## Local data

Hrrrwork stores settings, pending relay metadata, and short operational events in Electron's per-user application-data directory. The optional Claude Code integration stores session IDs, working directories, lifecycle state, and quota windows in `~/.hrrrwork/claude`; it does not store prompts, conversation bodies, or authentication tokens. Authentication remains owned by the locally installed Codex and Claude Code clients.

Connecting Claude Code adds local lifecycle hooks and a status-line wrapper to its settings, preserving the existing configuration and creating a backup before the first change. Disconnecting removes Hrrrwork's own hooks and restores the previous status line. Resumed sessions retain the client's permission rules; Hrrrwork does not bypass approval prompts.
