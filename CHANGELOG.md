# Changelog

All notable project changes are recorded here in Keep a Changelog 1.1.0 style.

## [Unreleased]

- [2026-09-04] Removed the unused two-clone deployment launcher and example config; production remains one VPS-routed minimal clone with the root front door reserved for plugin2 fallback, while cross-instance behavior stays regression-tested.
- [2026-09-03] Retired front-door static clone routing and direct Tailscale `/clone-*` handlers after MCPv3 moved to the VPS edge; the authorized plugin2 fallback keeps only the public Funnel root on port 3003.
- [2026-09-03] Restored the accepted MCPv3 process-tool description/schema contract after an unnecessary post-acceptance description mutation, kept PowerShell hardening internal to `start_process`, and added a byte-level contract freeze check so ordinary implementation work cannot silently rewrite the model-facing tool contract.
- [2026-09-03] Persisted rejected `start_process` PowerShell preflight attempts into the same seven-day day-sharded archive as completed process receipts, including caller, bounded command text, working directory, reason, and rejection id, so prevented command-generation regressions remain auditable after transport-log rotation.
- [2026-09-03] Added a Windows PowerShell 5.1 command guard at the process boundary: unsupported PS7 operators, direct control-statement piping, unbalanced delimiters, and writes to automatic `$PID`/`$args` are rejected before process start, and the `start_process` contract now states the known PS5.1 incompatibilities explicitly.
- [2026-09-03] Split completed-process receipt storage into a 30-minute flat hot cache and a seven-day day-sharded durable archive, with upgrade migration before pruning, so debugging and audit evidence no longer disappears after the live handoff window.
- [2026-09-03] Moved MCPv3 production ingress from Tailscale Funnel to a Caddy VPS edge with a persistent reverse SSH tunnel to loopback clone 3011; the final scheduled-tunnel path passed 100/100 consecutive `initialize -> initialized -> start_process` sequences and live MCPv3 calls reached the backend with `via_funnel=false`.
- [2026-09-03] Allowed credential-free non-`.ts.net` HTTPS `MCP_PUBLIC_ORIGIN` values so ordinary reverse proxies can preserve the same OAuth/resource contract (PR #45).
- [2026-08-27] Reduced process-tool round trips: `start_process` now collapses short commands with a 750 ms default completion wait, `read_output` defaults to a 2 s change wait and returns a compact `no_change` heartbeat instead of repeated output, and the rolling launch token bucket was removed while the 5-live-process cap and duplicate reuse remain.
- [2026-08-27] Added owner-relayed cross-clone live-process control for the minimal connector pool: a backup clone can read or kill a still-running process through the shared local control mailbox while the creating clone remains the only process owner; completed receipts remain the durable handoff path (regression-research #125).
- [2026-08-27] Proved `read_output(wait_ms=0)` is server-side nonblocking and clarified that response `elapsed_ms` is process age after #125 transport evidence showed a 3.2-second user-visible delay occurred before the follow-up request reached MCP, not inside `read_output`.
- [2026-08-27] Added path-scoped public identities for minimal MCP clones so redundant connectors can share standard HTTPS 443 behind distinct paths while preserving correct OAuth/resource metadata and leaving the production root connector unchanged (regression-research #125).
- [2026-08-27] Added an opt-in three-tool process-only MCP profile plus repeatable two-clone launch/configuration and multi-client/cross-clone failover proof for regression-research #125; the default full MCP0 tool surface remains unchanged.
- [2026-08-27] Preserved versioned standalone-coordinator job and checkpoint metadata across legacy MCP BUSY claim, list, prune, and release writes so redundant connector apps can share one canonical state authority (regression-research #125).
- [2026-08-26] Restored Node's default client-error cleanup at the stable front door so reset or malformed Funnel-facing sockets are closed instead of retained, with an off-path regression probe (#7).
- [2026-08-26] Added front-door request-boundary telemetry for `/mcp` arrival, backend selection/dispatch/response/close, without logging headers, request bodies, or tool arguments, so connector non-arrival can be distinguished from front-door forwarding failure (#7).
- [2026-08-26] Added a transparent stable front door with blue/green loopback backends, process-generation pinning, shared OAuth/BUSY state, and off-path proof that backend replacement leaves health continuously available without changing the seven-tool worker contract (#7).
- [2026-08-26] Kept ordinary task BUSY claims durable until explicit release, including across listener and tool-context recovery (#13).
- [2026-08-25] Added server-boundary incident classification so pre-dispatch, local-listener, Funnel, server-response, and bounded-wait failures are not collapsed into one MCP failure class (#7).
- [2026-08-25] Added reproducible transport-generation evidence and repair reporting for the historical MCP corpus (#12).
- [2026-08-25] Retained dormant production OAuth registrations and recovered stale ChatGPT client registrations without resetting the OAuth store.

[Unreleased]: https://github.com/organicoverlords/chatgpt-mcp-clean/compare/e154264...HEAD
