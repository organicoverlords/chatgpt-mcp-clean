# Clean MCP repository rules

This repository is transport infrastructure only. Keep it small.

Never add server-injected project memory, AGENTS/CLAUDE loading, workspace inventories, absolute workspace paths in MCP instructions/tool metadata, orchestration state, worker scheduling, worker registries, leases, prompt-policy engines, upstream MCP aggregation, or automatic project scanning.

Allowed core: ChatGPT OAuth, bounded HTTP session recovery, stable MCP actor identity, audit events, bounded file/shell/git tools, GitHub issue/BUSY synchronization, and explicit read-only workflow-skill loaders.

BUSY is GitHub coordination evidence, not an MCP-owned lock or lease. Workers remain able to fall back to GitHub/repo state when MCP is unavailable.

Child processes must not inherit unrelated provider/API/MCP secrets. `.env` and runtime state stay untracked.

`npm test` must pass before deployment. The smoke test must prove OAuth refresh reuse, stable actor identity across restart, session recovery, no MCP `instructions` injection, no server/workspace path in the tool list or skill loaders, and child-secret filtering.
