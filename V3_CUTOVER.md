# MCP V3 cutover

## MCP owns

- authenticated MCP transport
- OAuth/resource boundary
- `start_process`, `read_output`, `kill_process`
- process identity, receipts, and bounded paging
- structured local execution and supported OMEN delegation
- artifact handoff attached to process results
- transport/runtime diagnostics

## V3 stack owns

- Busy/exact-scope collision coordination
- queueing and scheduling
- resource admission
- deployment and topology convergence
- recovery orchestration
- bootstrap/orientation
- project routing and cross-repo coordination

## Vault/Memory owns

Historical incident material, retired freezes, reports, and old topology evidence.

## Integration rule

The stack calls MCP process tools. MCP returns execution evidence but does not decide what project work should run or when. Redundant bindings are transport redundancy, not separate workflow authorities.
