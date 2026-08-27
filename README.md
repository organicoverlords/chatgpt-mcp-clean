# ChatGPT MCP Clean

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-08-27] Added owner-relayed cross-clone live-process control for the minimal connector pool: a backup clone can read or kill a still-running process through the shared local control mailbox while the creating clone remains the only process owner; completed receipts remain the durable handoff path (regression-research #125).
- [2026-08-27] Proved `read_output(wait_ms=0)` is server-side nonblocking and clarified that response `elapsed_ms` is process age after #125 transport evidence showed a 3.2-second user-visible delay occurred before the follow-up request reached MCP, not inside `read_output`.
- [2026-08-27] Added path-scoped public identities for minimal MCP clones so redundant connectors can share standard HTTPS 443 behind distinct paths while preserving correct OAuth/resource metadata and leaving the production root connector unchanged (regression-research #125).
- [2026-08-27] Added an opt-in three-tool process-only MCP profile plus repeatable two-clone launch/configuration and multi-client/cross-clone failover proof for regression-research #125; the default full MCP0 tool surface remains unchanged.
- [2026-08-27] Preserved versioned standalone-coordinator job and checkpoint metadata across legacy MCP BUSY claim, list, prune, and release writes so redundant connector apps can share one canonical state authority (regression-research #125).

See the canonical [CHANGELOG.md](CHANGELOG.md) for the complete project timeline.
<!-- PROJECT-TIMELINE:END -->

Minimal authenticated Streamable HTTP MCP for the local Windows shell/process control boundary. The public endpoint remains stable while replaceable loopback backends are built, tested, switched, and drained behind a transparent front door.

The default full worker-visible contract is exactly `view_image`, `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`; the opt-in `process` profile intentionally exposes only the three process tools.
## Minimal redundant connector profile

For regression-research #125, `MCP_TOOL_PROFILE=process` exposes only `start_process`, `read_output`, and `kill_process`. The default `full` profile remains unchanged. Minimal connector instances are stateless per MCP request, keep their OAuth/transport state separate, and may share the process receipt directory. Completed process receipts are readable through any clone; while a process is still running, cross-clone `read_output` and `kill_process` are relayed through a shared local control mailbox to the clone that actually owns the in-memory process. No backup clone kills a PID directly. BUSY/job coordination stays outside MCP in the standalone Rust/Python tool apps and is not duplicated into the connector.

Use `scripts/start-minimal-clone.ps1` for one instance or `scripts/start-two-minimal-clones.ps1` with `config/minimal-clones.example.json` for the initial two-instance rollout. The sample config is intentionally only two instances; scale-out remains configuration, not code copies. `MCP_PUBLIC_ORIGIN` may include a path prefix (for example `/clone-a`) so multiple independently registered connectors can share ordinary HTTPS 443 while advertising distinct OAuth/resource identities.
