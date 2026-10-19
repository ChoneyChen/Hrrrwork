# Security Policy

## Reporting

Please use GitHub's private security advisory flow to report a vulnerability. Do not include live Codex tokens, private thread contents, or account identifiers in a public issue.

## Local data

Hrrrwork stores settings, pending relay metadata, and short operational events in Electron's per-user application-data directory. The optional Claude Code integration stores session IDs, working directories, lifecycle state, and quota windows in `~/.hrrrwork/claude`; it does not store prompts, conversation bodies, or authentication tokens. Authentication remains owned by the locally installed Codex and Claude Code clients.

Connecting Claude Code adds local lifecycle hooks and a status-line wrapper to its settings, preserving the existing configuration and creating a backup before the first change. Disconnecting removes Hrrrwork's own hooks and restores the previous status line. Resumed sessions retain the client's permission rules; Hrrrwork does not bypass approval prompts.

## Optional quota wake

Quota wake is off by default, including on upgrades. Enabling it authorizes a short scheduled message to a new conversation or an explicitly selected idle conversation. A durable receipt is written before dispatch; uncertain results are not automatically replayed. Wake messages consume usage and do not guarantee a particular quota window or cost. No reset credits are redeemed.

New Codex wake conversations use a dedicated local directory and a read-only sandbox. Claude wake runs disable built-in and MCP tools and are limited to one agentic turn. Choosing an existing conversation includes its history and may change its selected model. The coding clients retain their normal conversation-storage behavior; Hrrrwork does not additionally log response bodies.

## Software updates

From v1.2, automatic release checking and installer downloads are enabled by default, with separate switches in settings. Requests only contact this project's public GitHub release endpoints and asset CDN; no coding-client credentials or conversation content are included. Only stable versions and exact platform/architecture asset names are accepted. Every installer must match the release asset's SHA-256 digest and size before becoming available, and is rechecked before reveal. A digest confirms integrity against GitHub release metadata, not independent publisher identity or operating-system signing.

Installers are saved in the application's per-user `updates` cache, never executed automatically. Incomplete downloads are removed on handled failure. Installation is explicitly performed by the user, after exiting the running application. Existing configuration and relay receipts remain in the same application-data directory.

On Linux, detection can inspect same-user Codex processes to locate the bundled CLI and inherit only `CODEX_HOME` / `CODEX_SQLITE_HOME`. It does not copy, persist, or display arbitrary process environment variables.
