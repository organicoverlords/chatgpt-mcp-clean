# ChatGPT MCP Clean

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-08-27] Reduced process-tool round trips: `start_process` now collapses short commands with a 750 ms default completion wait, `read_output` defaults to a 2 s change wait and returns a compact `no_change` heartbeat instead of repeated output, and the rolling launch token bucket was removed while the 5-live-process cap and duplicate reuse remain.
- [2026-08-27] Added optional static clone routing at the stable front door so `/clone-a` and `/clone-b` can share one Funnel target on port 3003 instead of exposing ports 3011/3012 directly; root generation/process pinning is unchanged and clone OAuth metadata paths remain intact (regression-research #125).
- [2026-08-27] Added owner-relayed cross-clone live-process control for the minimal connector pool: a backup clone can read or kill a still-running process through the shared local control mailbox while the creating clone remains the only process owner; completed receipts remain the durable handoff path (regression-research #125).
- [2026-08-27] Proved `read_output(wait_ms=0)` is server-side nonblocking and clarified that response `elapsed_ms` is process age after #125 transport evidence showed a 3.2-second user-visible delay occurred before the follow-up request reached MCP, not inside `read_output`.
- [2026-08-27] Added path-scoped public identities for minimal MCP clones so redundant connectors can share standard HTTPS 443 behind distinct paths while preserving correct OAuth/resource metadata and leaving the production root connector unchanged (regression-research #125).

See the canonical [CHANGELOG.md](CHANGELOG.md) for the complete project timeline.
<!-- PROJECT-TIMELINE:END -->

Minimal authenticated Streamable HTTP MCP for the local Windows shell/process control boundary. The public endpoint remains stable while replaceable loopback backends are built, tested, switched, and drained behind a transparent front door.

The default full worker-visible contract is exactly `view_image`, `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`; the opt-in `process` profile intentionally exposes only the three process tools.
## Minimal redundant connector profile

For regression-research #125, `MCP_TOOL_PROFILE=process` exposes only `start_process`, `read_output`, and `kill_process`. The default `full` profile remains unchanged. Minimal connector instances are stateless per MCP request, keep their OAuth/transport state separate, and may share the process receipt directory. Completed process receipts are readable through any clone; while a process is still running, cross-clone `read_output` and `kill_process` are relayed through a shared local control mailbox to the clone that actually owns the in-memory process. No backup clone kills a PID directly. BUSY/job coordination stays outside MCP in the standalone Rust/Python tool apps and is not duplicated into the connector.

Use `scripts/start-minimal-clone.ps1` for one instance or `scripts/start-two-minimal-clones.ps1` with `config/minimal-clones.example.json` for the initial two-instance rollout. The sample config is intentionally only two instances; scale-out remains configuration, not code copies. `MCP_PUBLIC_ORIGIN` may include a path prefix (for example `/clone-a`) so multiple independently registered connectors can share ordinary HTTPS 443 while advertising distinct OAuth/resource identities.

The stable front door can also terminate those clone paths before forwarding them to loopback-only clone listeners. Put a version-1 route map such as `{ "version": 1, "routes": { "clone-a": 3011, "clone-b": 3012 } }` at `.state/front-door/static-routes.json`. Requests under `/clone-a/*` and `/clone-b/*` are forwarded with that public prefix stripped, while the path-scoped OAuth/OpenID `.well-known` endpoints are forwarded unchanged. This lets Tailscale Funnel use one local target (`127.0.0.1:3003`) instead of exposing each clone listener as a separate Funnel handler. The normal root backend generation/pinning path is unchanged.
