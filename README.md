# ChatGPT MCP Clean

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-09-04] Removed the unused two-clone deployment launcher and example config; production remains one VPS-routed minimal clone with the root front door reserved for plugin2 fallback, while cross-instance behavior stays regression-tested.
- [2026-09-03] Retired front-door static clone routing and direct Tailscale `/clone-*` handlers after MCPv3 moved to the VPS edge; the authorized plugin2 fallback keeps only the public Funnel root on port 3003.
- [2026-09-03] Restored the accepted MCPv3 process-tool description/schema contract after an unnecessary post-acceptance description mutation, kept PowerShell hardening internal to `start_process`, and added a byte-level contract freeze check so ordinary implementation work cannot silently rewrite the model-facing tool contract.
- [2026-09-03] Persisted rejected `start_process` PowerShell preflight attempts into the same seven-day day-sharded archive as completed process receipts, including caller, bounded command text, working directory, reason, and rejection id, so prevented command-generation regressions remain auditable after transport-log rotation.
- [2026-09-03] Added a Windows PowerShell 5.1 command guard at the process boundary: unsupported PS7 operators, direct control-statement piping, unbalanced delimiters, and writes to automatic `$PID`/`$args` are rejected before process start, and the `start_process` contract now states the known PS5.1 incompatibilities explicitly.

See the canonical [CHANGELOG.md](CHANGELOG.md) for the complete project timeline.
<!-- PROJECT-TIMELINE:END -->

Minimal authenticated Streamable HTTP MCP for the local Windows shell/process control boundary. The current MCPv3 production path is public Caddy HTTPS on the VPS -> persistent reverse SSH -> loopback-only minimal clone on port 3011. The legacy local front door remains available for root/fallback topology but is not the current MCPv3 public ingress.

The default full worker-visible contract is exactly `view_image`, `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`; the opt-in `process` profile intentionally exposes only the three process tools.
## Minimal redundant connector profile

For regression-research #125, `MCP_TOOL_PROFILE=process` exposes only `start_process`, `read_output`, and `kill_process`. The default `full` profile remains unchanged. Minimal connector instances are stateless per MCP request, keep their OAuth/transport state separate, and may share the process receipt directory. Completed process receipts are readable through any clone and are copied into `shared-process-receipts/archive/YYYY-MM-DD/` for seven days; the flat 30-minute receipt cache remains only a fast handoff/read path. On upgrade, legacy flat receipts are archived before they are pruned. While a process is still running, cross-clone `read_output` and `kill_process` are relayed through a shared local control mailbox to the clone that actually owns the in-memory process. No backup clone kills a PID directly. BUSY/job coordination stays outside MCP in the standalone Rust/Python tool apps and is not duplicated into the connector.

Use `scripts/start-minimal-clone.ps1` to launch a minimal connector instance. `MCP_PUBLIC_ORIGIN` may include a path prefix when a distinct OAuth/resource identity is required.
