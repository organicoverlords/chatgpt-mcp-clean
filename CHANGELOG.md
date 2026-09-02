# Changelog

All notable project changes are recorded here in Keep a Changelog 1.1.0 style.

## [Unreleased]

- [2026-09-02] Bounded backend transport and front-door request JSONL telemetry to 16 MiB per file with 24-hour rotation and three retained backups; added stress/restart regression while preserving the no-secret/no-command telemetry contract.
- [2026-09-02] Restored clone-path backend TCP session reuse after array fallback health probes regressed to one fresh TCP connection per tool call; the original connection-reuse guard is back and proves 60 sequential clone requests use at most two backend connections.
- [2026-09-02] Reconciled and pinned the process transport contract: 32,000-character reads, automatic 750 ms `start_process` wait, five live processes per caller, no rolling launch/token bucket, ordered compatible clone fallbacks, and stable OAuth/receipt reuse for replacement clones.
- [2026-09-02] Defined the MCP/coordinator operating boundary: clean deployment lanes, bounded telemetry/temp state, one standalone ownership authority, queue reconciliation, and no connector-driven task drift.
- [2026-08-30] Raised the bounded `read_output` stream window and advertised MCP schema from 6,000 to 32,000 characters after the old ~6 KB transport-wall hypothesis was rejected; added regressions proving the schema exposes 32 KB, a 24 KB result is delivered whole, and oversized output remains explicitly truncated. Live ChatGPT connector delivery still requires a separate canary before deployment.
- [2026-08-27] Added optional static clone routing at the stable front door so `/clone-a` and `/clone-b` can share one Funnel target on port 3003 instead of exposing ports 3011/3012 directly; root generation/process pinning is unchanged and clone OAuth metadata paths remain intact (regression-research #125).
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
