# MCP V3

MCP V3 is the authenticated transport and process-control boundary for the V3 stack.

Its public tool surface is exactly `start_process`, `read_output`, and `kill_process`.

MCP owns transport, process execution and receipts, bounded output paging, artifact handoff, execution-target delegation, and transport diagnostics. The V3 stack owns scheduling, collision coordination, resource admission, deployment topology, recovery orchestration, bootstrap/orientation, and cross-project integration.

MCP does not own Lane Finals, Tiny3D, Vault/Memory, CI fleets, or proof/review policy.

See `V3_CUTOVER.md` and `MCP_V3_CONTRACT.json`.
