# Security Policy

## Reporting

Please use GitHub's private security advisory flow to report a vulnerability. Do not include live Codex tokens, private thread contents, or account identifiers in a public issue.

## Local data

SleepRelay stores settings, pending relay metadata, and short operational events in Electron's per-user application-data directory. It does not intentionally persist authentication tokens or conversation bodies. Authentication remains owned by the locally installed Codex client.
