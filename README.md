# ChatGPT MCP Clean

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-08-26] Added a transparent stable front door with blue/green loopback backends, process-generation pinning, shared OAuth/BUSY state, and off-path proof that backend replacement leaves health continuously available without changing the seven-tool worker contract (#7).
- [2026-08-26] Kept ordinary task BUSY claims durable until explicit release, including across listener and tool-context recovery (#13).
- [2026-08-25] Added server-boundary incident classification so pre-dispatch, local-listener, Funnel, server-response, and bounded-wait failures are not collapsed into one MCP failure class (#7).
- [2026-08-25] Added reproducible transport-generation evidence and repair reporting for the historical MCP corpus (#12).
- [2026-08-25] Retained dormant production OAuth registrations and recovered stale ChatGPT client registrations without resetting the OAuth store.

See the canonical [CHANGELOG.md](CHANGELOG.md) for the complete project timeline.
<!-- PROJECT-TIMELINE:END -->

Minimal authenticated Streamable HTTP MCP for the local Windows shell/process control boundary. The public endpoint remains stable while replaceable loopback backends are built, tested, switched, and drained behind a transparent front door.

The worker-visible contract is exactly `view_image`, `start_process`, `read_output`, `kill_process`, `busy_list`, `busy_claim`, and `busy_release`.
