# ChatGPT MCP Clean

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-09-02] Made the default `start_process` wait budget include synchronous Windows process creation so host/editor startup pressure cannot add a second full 750 ms wait and push an otherwise healthy MCP request past the connector deadline.
- [2026-09-02] Reconciled and pinned the process transport contract: 32,000-character reads, automatic 750 ms `start_process` wait, five live processes per caller, no rolling launch/token bucket, ordered compatible clone fallbacks, and stable OAuth/receipt reuse for replacement clones.
- [2026-09-02] Defined the MCP/coordinator operating boundary: clean deployment lanes, bounded telemetry/temp state, one standalone ownership authority, queue reconciliation, and no connector-driven task drift.
- [2026-08-30] Raised the bounded `read_output` stream window and advertised MCP schema from 6,000 to 32,000 characters after the old ~6 KB transport-wall hypothesis was rejected; added regressions proving the schema exposes 32 KB, a 24 KB result is delivered whole, and oversized output remains explicitly truncated. Live ChatGPT connector delivery still requires a separate canary before deployment.
- [2026-08-27] Added optional static clone routing at the stable front door so `/clone-a` and `/clone-b` can share one Funnel target on port 3003 instead of exposing ports 3011/3012 directly; root generation/process pinning is unchanged and clone OAuth metadata paths remain intact (regression-research #125).

See the canonical [CHANGELOG.md](CHANGELOG.md) for the complete project timeline.
<!-- PROJECT-TIMELINE:END -->

Minimal authenticated Streamable HTTP MCP for the local Windows shell/process control boundary. The public endpoint remains stable while replaceable loopback backends are built, tested, switched, and drained behind a transparent front door.

The default full worker-visible contract is exactly `view_image`, `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`; the opt-in `process` profile intentionally exposes only the three process tools.

## Process transport invariants

The merged runtime contract is intentionally small and must not drift between `master` and deployed clone generations:

- `read_output` accepts up to **32,000 characters per stream**; 6,000 was a rejected historical workaround.
- `start_process` waits up to **750 ms by default** so fast commands can complete inline; longer commands return `RUNNING` and retain the same `process_id`. `wait_ms=0` is the explicit nonblocking override.
- A caller may own **five live processes** at once; the sixth is rejected.
- There is **no rolling launch/token bucket**. The live-process ceiling is the admission bound.
- Ordered clone fallbacks must contain only generations compatible with this contract. Replacement instances preserve the stable public clone OAuth store and shared process receipts.
- A cached client tool schema can lag a deployment. When schema freshness matters, acceptance is the authenticated public `tools/list` plus a semantic process smoke/canary, not the cache alone.

## Minimal redundant connector profile

For regression-research #125, `MCP_TOOL_PROFILE=process` exposes only `start_process`, `read_output`, and `kill_process`. The default `full` profile remains unchanged. Minimal connector instances are stateless per MCP request, keep their OAuth/transport state separate, and may share the process receipt directory. Completed process receipts are readable through any clone; while a process is still running, cross-clone `read_output` and `kill_process` are relayed through a shared local control mailbox to the clone that actually owns the in-memory process. No backup clone kills a PID directly. BUSY/job coordination stays outside MCP in the standalone Rust/Python tool apps and is not duplicated into the connector.

Use `scripts/start-minimal-clone.ps1` for one instance or `scripts/start-two-minimal-clones.ps1` with `config/minimal-clones.example.json` for the initial two-instance rollout. The sample config is intentionally only two instances; scale-out remains configuration, not code copies. `MCP_PUBLIC_ORIGIN` may include a path prefix (for example `/clone-a`) so multiple independently registered connectors can share ordinary HTTPS 443 while advertising distinct OAuth/resource identities.

The stable front door can also terminate those clone paths before forwarding them to loopback-only clone listeners. Put a version-1 route map such as `{ "version": 1, "routes": { "clone-a": [3011, 3041], "clone-b": [3022, 3012] } }` at `.state/front-door/static-routes.json`. Requests under `/clone-a/*` and `/clone-b/*` are forwarded with that public prefix stripped, while the path-scoped OAuth/OpenID `.well-known` endpoints are forwarded unchanged. This lets Tailscale Funnel use one local target (`127.0.0.1:3003`) instead of exposing each clone listener as a separate Funnel handler. The normal root backend generation/pinning path is unchanged.
