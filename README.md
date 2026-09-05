# ChatGPT MCP Clean

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-09-05] Promoted an OS-level WireGuard link (VPS `10.203.0.1/30` to Windows `10.203.0.2/30`) to Caddy's primary MCP upstream while retaining the four independent native OpenSSH lanes as ordered health-checked failover; the Windows tunnel service auto-starts and a persistent portproxy bound to `10.203.0.2:3011` forwards to the loopback backend; no separate `MCP WireGuard 3011` Windows firewall rule was created.
- [2026-09-05] Replaced the single Python/AsyncSSH VPS reverse tunnel with four independent native OpenSSH lanes behind Caddy round-robin health-aware routing; one-lane failure now leaves the other three serving and the existing recovery task recreates only the missing lane.
- [2026-09-04] Removed the orphaned public-health monitor and uncalled `keepalive.ps1 -Role Legacy` supervisor mode left behind by the retired port-3000 cutover path.
- [2026-09-04] Removed the obsolete one-time front-door cutover script that could repoint Tailscale Funnel back to dead legacy port 3000; the surviving fallback is the existing root Funnel to port 3003.
- [2026-09-04] Removed the unused two-clone deployment launcher and example config; production remains one VPS-routed minimal clone with the root front door reserved for plugin2 fallback, while cross-instance behavior stays regression-tested.

See the canonical [CHANGELOG.md](CHANGELOG.md) for the complete project timeline.
<!-- PROJECT-TIMELINE:END -->

Minimal authenticated Streamable HTTP MCP for the local Windows shell/process control boundary. The current MCPv3 production path is public Caddy HTTPS on the VPS -> an OS-level WireGuard link (`10.203.0.1/30` on the VPS to `10.203.0.2/30` on Windows) -> a persistent Windows TCP portproxy on `10.203.0.2:3011` -> the loopback-only minimal clone on `127.0.0.1:3011`. Caddy keeps four independent native OpenSSH reverse tunnels on VPS loopback ports 3101-3104 as ordered health-checked failover, so the fallback stack remains live without sitting on the primary path. No Python/AsyncSSH forwarding process or single shared SSH TCP stream is required by the primary path. The legacy local front door remains available for root/fallback topology but is not the current MCPv3 public ingress.

The default full worker-visible contract is exactly `view_image`, `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`; the opt-in `process` profile intentionally exposes only the three process tools.

Process execution uses PowerShell 7 at `C:\Program Files\PowerShell\7\pwsh.exe` with no Windows PowerShell 5.1 fallback. The process preflight rejects drive-root recursive enumeration/search before spawn while allowing recursion under explicit project/subdirectory roots. Completed output retains up to 100,000 characters per stream and pages through the same `process_id` in 32,000-character logical pages.
## Minimal redundant connector profile

For regression-research #125, `MCP_TOOL_PROFILE=process` exposes only `start_process`, `read_output`, and `kill_process`. The default `full` profile remains unchanged. Minimal connector instances are stateless per MCP request, keep their OAuth/transport state separate, and may share the process receipt directory. Completed process receipts are readable through any clone and are copied into `shared-process-receipts/archive/YYYY-MM-DD/` for seven days; the flat 30-minute receipt cache remains only a fast handoff/read path. On upgrade, legacy flat receipts are archived before they are pruned. While a process is still running, cross-clone `read_output` and `kill_process` are relayed through a shared local control mailbox to the clone that actually owns the in-memory process. No backup clone kills a PID directly. BUSY/job coordination stays outside MCP in the standalone Rust/Python tool apps and is not duplicated into the connector.

Use `scripts/start-minimal-clone.ps1` to launch a minimal connector instance. `MCP_PUBLIC_ORIGIN` may include a path prefix when a distinct OAuth/resource identity is required.
