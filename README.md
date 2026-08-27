# ChatGPT MCP Clean

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-08-27] Added an opt-in three-tool process-only MCP profile plus repeatable two-clone launch/configuration and multi-client/cross-clone failover proof for regression-research #125; the default full MCP0 tool surface remains unchanged.
- [2026-08-27] Preserved versioned standalone-coordinator job and checkpoint metadata across legacy MCP BUSY claim, list, prune, and release writes so redundant connector apps can share one canonical state authority (regression-research #125).
- [2026-08-26] Restored Node's default client-error cleanup at the stable front door so reset or malformed Funnel-facing sockets are closed instead of retained, with an off-path regression probe (#7).
- [2026-08-26] Added front-door request-boundary telemetry for `/mcp` arrival, backend selection/dispatch/response/close, without logging headers, request bodies, or tool arguments, so connector non-arrival can be distinguished from front-door forwarding failure (#7).
- [2026-08-26] Added a transparent stable front door with blue/green loopback backends, process-generation pinning, shared OAuth/BUSY state, and off-path proof that backend replacement leaves health continuously available without changing the seven-tool worker contract (#7).

See the canonical [CHANGELOG.md](CHANGELOG.md) for the complete project timeline.
<!-- PROJECT-TIMELINE:END -->

Minimal authenticated Streamable HTTP MCP for the local Windows shell/process control boundary. The public endpoint remains stable while replaceable loopback backends are built, tested, switched, and drained behind a transparent front door.

The default full worker-visible contract is exactly `view_image`, `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`; the opt-in `process` profile intentionally exposes only the three process tools.
## Minimal redundant connector profile

For regression-research #125, `MCP_TOOL_PROFILE=process` exposes only `start_process`, `read_output`, and `kill_process`. The default `full` profile remains unchanged. Minimal connector instances are stateless per MCP request, keep their OAuth/transport state separate, and may share the process receipt directory so a completed process started through one connector can be read through another. BUSY/job coordination stays outside MCP in the standalone Rust/Python tool apps and is not duplicated into the connector.

Use `scripts/start-minimal-clone.ps1` for one instance or `scripts/start-two-minimal-clones.ps1` with `config/minimal-clones.example.json` for the initial two-instance rollout. The sample config is intentionally only two instances; scale-out remains configuration, not code copies.
