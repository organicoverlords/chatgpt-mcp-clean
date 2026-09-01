# North star

Current focus (2026-09-02): keep the public MCP transport continuously reachable through backend deployments while preserving the exact minimal worker contract and every recoverable process, OAuth, and BUSY state transition—without allowing the transport, telemetry or coordinator queue to become a second product.

The service should be boring infrastructure: transparent to workers, explicit about uncertainty, least-privilege, restartable behind a stable endpoint, and measurable at the local-server/Funnel boundary.

## Operating contract

1. **MCP is transport, not work authority.** A missing connector binding or failed route never blocks work that can continue through local shell, authenticated APIs or another supported transport. MCP does not schedule, prioritize or declare product completion.
2. **BusyCoordinator is the only ownership authority.** The root connector may expose compatibility BUSY tools, but it must preserve unknown top-level state and the complete `coordinator` object on every write. Connector health, issue titles, branches and process counts are projections only.
3. **A healthy server is a narrow fact.** `/health`, a listener PID and successful `tools/list` do not prove that ChatGPT is bound to the connector, that a request arrived, or that downstream work advanced.
4. **The live install is a deployment target, not a development worktree.** Source changes happen in a clean task lane, pass tests, merge, and deploy through a recorded generation/rollback procedure. Uncommitted experiments, screenshots and retired workflow copies do not accumulate in the running checkout.
5. **Telemetry is bounded infrastructure.** Transport, request and BUSY audit logs have a size/age rotation policy, bounded backup count and explicit redaction contract. Orphan atomic-write temp files are swept only when no live writer owns them. Disk growth is reported before it can compete with product builds.
6. **Coordinator queues require product pull discipline.** Ready-job count is not throughput. Stale/duplicate ready work is reconciled against live issues/PRs; active WIP follows the product integration bottleneck; workers pull the oldest valuable unblocked item instead of creating more queue entries.
7. **No self-debugging drift.** A normal task must not become an MCP rewrite because a route was slow or absent. Capture the exact boundary once, route around it, and repair MCP only in an explicitly owned infrastructure scope.

## 2026-09-02 live findings

- local `shell-mcp` health was `ok` on `127.0.0.1:3000`, with no active request;
- canonical BUSY state contained both `claims` and versioned `coordinator` metadata, so the prior metadata-erasure defect was not reproduced;
- the coordinator held 297 ready jobs, zero active jobs, four blocked jobs and 145 completed jobs, showing queue accumulation without current product pull;
- `.state/transport.jsonl` had grown to about 168 MiB with no source-side rotation;
- 45 orphan `busy-claims.json.<pid>.tmp` files occupied about 3.8 MiB;
- the running checkout contained unrelated uncommitted/untracked files and was on a checkpoint branch despite `origin/master` moving ahead.

The corrective priority is therefore bounded state and queue hygiene—not another transport redesign.
