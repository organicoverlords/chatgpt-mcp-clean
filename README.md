# ChatGPT MCP Clean

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-09-02] Isolated worker-wide tool drops to Windows Tailscale 1.102.3 HTTPS Funnel ingress and restored the existing raw-TCP/TLS-bridge bypass: `443 -> 3443 -> 3003 -> pinned clone-a 55578`. All five latest workers reported 17 drops; backend telemetry showed both pre-arrival loss and one early response close. The raw ingress A/B passed 5/5 starts + 5/5 original-ID reads with zero retries. Clone promotion and the FrontDoor supervisor now preserve raw TCP mode instead of restoring HTTPS Funnel path proxying.
- [2026-09-02] Restored the proven direct production clone ingress from issue #37: a path-scoped clone MCP handler plus its OAuth/OpenID metadata handlers route directly to the selected compatible clone listener while root `/` remains on 3003. This supersedes the Sep 1 single-front-door clone canonicalization after same-chat 10/10 starts + 10/10 reads and fresh-chat 5/5 starts + 5/5 reads passed with zero drops or retries on direct clone-a.
- [2026-09-02] Restored the Aug 29 MCP stability combination: clone tool calls no longer run health-preflight routing, and process-profile replacements are pinned to one explicit tools/list contract before launch.
- [2026-09-02] Bounded backend transport and front-door request JSONL telemetry to 16 MiB per file with 24-hour rotation and three retained backups; added stress/restart regression while preserving the no-secret/no-command telemetry contract.
- [2026-09-02] Restored clone-path backend TCP session reuse after array fallback health probes regressed to one fresh TCP connection per tool call; the original connection-reuse guard is back and proves 60 sequential clone requests use at most two backend connections.

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

Production ingress on Windows Tailscale 1.102.3 uses **raw TCP Funnel**, not Tailscale HTTPS path proxying. Port 443 forwards encrypted TCP to a local TLS bridge on 3443; the bridge forwards path-preserved HTTP to the stable front door on 3003, and the front door pins `clone-a` to the selected compatible listener. This avoids the open upstream Funnel request-drop bug while retaining one OAuth identity, shared receipts, and deterministic clone routing.

### Raw TCP clone ingress recovery

After a Funnel reset, bridge loss, clone listener promotion, or suspected topology drift, restore/verify the raw TCP ingress and pinned clone route:

`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/set-direct-clone-funnel.ps1 -InstanceId clone-a -Port <compatible-port> -PublicOrigin https://<public-host>/clone-a`

Use `-VerifyOnly` for a read-only check. The verifier requires raw `TCPForward=127.0.0.1:3443`, a live bridge, the exact static clone backend, and all four public clone/OAuth paths. Promotion is not complete until a fresh ChatGPT chat also passes five `start_process(wait_ms=0)` calls plus reads of the five original process IDs with zero silent retries. For any client-visible failure, correlate its timestamp with backend arrival before changing another layer.
