# ChatGPT MCP Clean

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-09-03] Added a Windows PowerShell 5.1 command guard at the process boundary: unsupported PS7 operators, direct control-statement piping, unbalanced delimiters, and writes to automatic `$PID`/`$args` are rejected before process start, and the `start_process` contract now states the known PS5.1 incompatibilities explicitly.
- [2026-09-03] Split completed-process receipt storage into a 30-minute flat hot cache and a seven-day day-sharded durable archive, with upgrade migration before pruning, so debugging and audit evidence no longer disappears after the live handoff window.
- [2026-09-03] Moved MCPv3 production ingress from Tailscale Funnel to a Caddy VPS edge with a persistent reverse SSH tunnel to loopback clone 3011; the final scheduled-tunnel path passed 100/100 consecutive `initialize -> initialized -> start_process` sequences and live MCPv3 calls reached the backend with `via_funnel=false`.
- [2026-09-03] Allowed credential-free non-`.ts.net` HTTPS `MCP_PUBLIC_ORIGIN` values so ordinary reverse proxies can preserve the same OAuth/resource contract (PR #45).
- [2026-08-27] Reduced process-tool round trips: `start_process` now collapses short commands with a 750 ms default completion wait, `read_output` defaults to a 2 s change wait and returns a compact `no_change` heartbeat instead of repeated output, and the rolling launch token bucket was removed while the 5-live-process cap and duplicate reuse remain.

See the canonical [CHANGELOG.md](CHANGELOG.md) for the complete project timeline.
<!-- PROJECT-TIMELINE:END -->

Minimal authenticated Streamable HTTP MCP for the local Windows shell/process control boundary. The current MCPv3 production path is public Caddy HTTPS on the VPS -> persistent reverse SSH -> loopback-only minimal clone on port 3011. The legacy local front door remains available for root/fallback topology but is not the current MCPv3 public ingress.

The default full worker-visible contract is exactly `view_image`, `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`; the opt-in `process` profile intentionally exposes only the three process tools.
## Minimal redundant connector profile

For regression-research #125, `MCP_TOOL_PROFILE=process` exposes only `start_process`, `read_output`, and `kill_process`. The default `full` profile remains unchanged. Minimal connector instances are stateless per MCP request, keep their OAuth/transport state separate, and may share the process receipt directory. Completed process receipts are readable through any clone and are copied into `shared-process-receipts/archive/YYYY-MM-DD/` for seven days; the flat 30-minute receipt cache remains only a fast handoff/read path. On upgrade, legacy flat receipts are archived before they are pruned. While a process is still running, cross-clone `read_output` and `kill_process` are relayed through a shared local control mailbox to the clone that actually owns the in-memory process. No backup clone kills a PID directly. BUSY/job coordination stays outside MCP in the standalone Rust/Python tool apps and is not duplicated into the connector.

Use `scripts/start-minimal-clone.ps1` for one instance or `scripts/start-two-minimal-clones.ps1` with `config/minimal-clones.example.json` for the initial two-instance rollout. The sample config is intentionally only two instances; scale-out remains configuration, not code copies. `MCP_PUBLIC_ORIGIN` may include a path prefix (for example `/clone-a`) so multiple independently registered connectors can share ordinary HTTPS 443 while advertising distinct OAuth/resource identities.

The stable front door can also terminate those clone paths before forwarding them to loopback-only clone listeners. Put a version-1 route map such as `{ "version": 1, "routes": { "clone-a": 3011, "clone-b": 3012 } }` at `.state/front-door/static-routes.json`. Requests under `/clone-a/*` and `/clone-b/*` are forwarded with that public prefix stripped, while the path-scoped OAuth/OpenID `.well-known` endpoints are forwarded unchanged. This remains a bounded legacy/fallback option. Current MCPv3 production ingress does not use Funnel; Caddy on the VPS forwards through a reverse SSH tunnel directly to the loopback-only clone. The normal root backend generation/pinning path is unchanged.
