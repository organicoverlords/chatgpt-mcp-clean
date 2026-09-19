# ChatGPT MCP Clean

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-09-19] Raised process and Bootstrap output paging to 100,000 characters per page so current Bootstrap V2 snapshots and larger command output require fewer reads.
- [2026-09-19] Raised explicit `start_process` and `read_output` waits to 240 seconds and aligned backend/front-door request ceilings at 270 seconds to reduce polling without exceeding the public five-minute idle window.
- [2026-09-19] Removed the inbound ChatGPT-to-host file-import tool from the production MCP profile; process MCP now exposes only `start_process`, `read_output`, and `kill_process`. Local process artifacts continue to use the existing outbound resource/result path.
- [2026-09-10] Historically split file transfer into explicit inbound/outbound actions (#235); the inbound ChatGPT-to-host action was removed from the MCP surface on 2026-09-19. Normal `start_process`/`read_output` do not mount a Library widget.
- [2026-09-10] Added the one-command local home-direct stack installer (#233): one Windows host gets the loopback MCP backend, pinned local Caddy, standalone BusyCoordinator, shared base rules, PlanOnly, and autostart; the ChatGPT connector remains exactly `start_process`, `read_output`, and `kill_process`, while Library delivery stays metadata/resource-widget behavior rather than a fourth tool.

See the canonical [CHANGELOG.md](CHANGELOG.md) for the complete project timeline.
<!-- PROJECT-TIMELINE:END -->

Minimal authenticated Streamable HTTP MCP for the local Windows shell/process control boundary. The current home-direct serving path runs on the Windows host: local HTTPS Caddy proxies to the loopback MCP backend on `127.0.0.1:3022`, with local-edge authorization. Historical VPS/WireGuard/tunnel tooling remains in the repository for recovery/research history but is not part of this current serving path or the one-package installer.

The default ChatGPT connector contract is `MCP_TOOL_PROFILE=process`, exposing exactly `start_process`, `read_output`, and `kill_process`. Images produced by commands are returned directly in the existing `start_process`/`read_output` result at original resolution; the image handoff adds only `resolution: WIDTHxHEIGHT` and no image hash/widget/bridge metadata. Producers may emit `CHATGPT_ARTIFACT=<absolute path>` for streaming output or a top-level JSON `chatgpt_artifacts` array for machine-readable results. Non-image media such as MP4 remains an ordinary artifact resource, while producers can declare full-resolution keyframes/contact sheets for inline inspection. The broader `full` profile adds only the three Busy tools for internal/local testing and is not the ChatGPT plugin surface.

## Full-stack disaster recovery

This section is the durable recovery entrypoint for a future ChatGPT session or human operator. **Do not rely on chat memory to reconstruct this stack.** If MCP itself is unavailable, start here from GitHub. The supported recovery target is a usable local Windows stack first; exact redundant/frozen bindings are restored only after control is back and current topology has been re-read.

### What is authoritative

Use these sources in this order. Current live evidence always outranks an old report or snapshot.

1. `organicoverlords/chatgpt-mcp-clean` `master`: current MCP source, the supported one-package installer, this recovery script, process contract, Busy package, and generic local Caddy install.
2. `organicoverlords/agents` `main`: canonical `RULES.md`, `AGENTS.md`, `CONTRACTS.json`, `Get-AgentContract.ps1`, agent pointers, and the Stack Atlas/contract PATH launchers. This is how the assistant's shared working instructions are restored.
3. `organicoverlords/regression-research` `main`, when the user's Vault is available: durable user directives/history plus `04 Operating Contracts/mcp-current-topology.json` and `mcp-recovery-state.json`. `mcp-current-topology.json` is the current-serving authority; `mcp-recovery-state.json` is **recovery metadata only** and must never be projected as current topology.
4. The live Windows machine after recovery: exact listeners, task actions, Caddy loaded/on-disk routes, runtime identity, OAuth store identity, and real Host `/mcp` behavior.
5. `chatgpt/home-direct-stable-runtime`: source owner for the long-lived home-direct Caddy supervisor/config. Use it only when restoring that user-specific serving layer; PR #391/#390 made boot recovery converge canonical routing while Caddy is down without weakening live-retarget protection.

Never hard-code a port, backend generation, binding order, or recovery commit from an old README paragraph, chat, report, or `mcp-recovery-state.json`. Read current topology and then verify live state. One healthy process binding is enough to regain control; redundant bindings are optional recovery/control lanes, not a prerequisite for normal operation.

### Recovery channels

#### GitHub-only recovery

A GitHub connector/plugin cannot execute Windows commands by itself. It **can** recover everything needed to get execution back:

1. Read this `README.md` from `organicoverlords/chatgpt-mcp-clean@master`.
2. Fetch `scripts/restore-stack-from-github.ps1` from the same ref and give that exact file to the user to run in PowerShell 7. Do not rewrite it from memory when GitHub is available.
3. If the user has access to `organicoverlords/regression-research`, read `04 Operating Contracts/mcp-current-topology.json` before making claims about the current ports/commits/routes. Read `mcp-recovery-state.json` only as rollback/recovery metadata.
4. After the script restores one healthy MCP process binding, switch back to MCP for machine work. Do not continue asking the user to manually orchestrate commands that MCP can perform.

If raw-file download is the only route, the user can save the `master` copy of `scripts/restore-stack-from-github.ps1` and run it locally. Prefer a GitHub connector/file fetch or a normal clone over copying a script from an old chat transcript.

#### Commander/local-shell recovery

Commander or any local shell is only an execution transport. Use it to run the same repository-owned script; do not create Commander-specific recovery logic. From a clean MCP repository clone:

```powershell
pwsh -File .\scripts\restore-stack-from-github.ps1 `
  -PublicOrigin https://YOUR-MCP-HOST `
  -OwnerLogin YOUR-OWNER-LOGIN `
  -RestoreUserContext
```

If a working MCP binding exists, run the same command through `start_process` instead. Use the current Vault `operator_route_preference` to select among actually exposed healthy bindings; do not hard-code a historical binding order in recovery code.

#### Single PowerShell restore

`scripts/restore-stack-from-github.ps1` is the one-script disaster bootstrap. It can be run from a downloaded copy with no pre-existing MCP checkout. It clones/fast-forwards clean GitHub checkouts, then delegates installation to the existing `install.ps1` / `scripts/install-stack.ps1` installer owner rather than duplicating installer logic.

Preview with **zero mutation**:

```powershell
pwsh -File .\scripts\restore-stack-from-github.ps1 -RestoreUserContext -Plan
```

Restore the supported functional stack and the user's control context:

```powershell
pwsh -File .\scripts\restore-stack-from-github.ps1 `
  -PublicOrigin https://YOUR-MCP-HOST `
  -OwnerLogin YOUR-OWNER-LOGIN `
  -RestoreUserContext
```

`-RestoreUserContext` additionally restores/updates the Vault checkout, canonical agent rules/contracts, Stack Atlas and `Get-AgentContract` entrypoints, `VaultCheckoutSync`, and the persistent bootstrap snapshot tasks. When Vault contains a valid current topology, `PublicOrigin` can be omitted and recovered from it. `OwnerLogin` can be recovered from an existing supported stack config or surviving current frozen owner file; otherwise the user must supply it because it is intentionally not stored in public GitHub.

The script requires Windows, PowerShell 7, Git, Node.js/npm, and Python. The underlying installer currently requires Node.js 20+. Creating the supported inbound Windows Firewall rule requires one elevated run unless `-SkipFirewall` is used because the rule already exists. The public HTTPS hostname/router path is external to GitHub: DNS/router/NAT must still deliver public TCP 443 to the Windows Caddy HTTPS port configured by the installer.

### What the one-script restore rebuilds

The supported functional restore includes the process-profile MCP server, local HTTPS Caddy, standalone BusyCoordinator, canonical shared rules/contracts, PlanOnly, scheduled autostart, and—when requested—the Vault/Stack Atlas/user-directive control layer. The process profile is exactly `start_process`, `read_output`, and `kill_process`.

The script preserves existing dirty Git checkouts and fails closed instead of resetting or cleaning them. It does not reboot. It does not delete frozen/rollback runtimes. It does not copy, merge, delete, or restore OAuth/token backups. If OAuth/connector authorization state is gone, first restore the endpoint, then reconnect/re-authorize the ChatGPT connector normally. **Never restore an old `oauth.json` over a live store merely because it exists in a backup.** Token/client rotation may have advanced.

A fresh functional install uses its own managed state under `%LOCALAPPDATA%\ChatGPTMcpStack`. Existing user-specific minimal-connector OAuth stores under `%LOCALAPPDATA%\ChatGPTMcpClean\minimal-connectors` are intentionally left untouched. Exact frozen lanes may reuse their own existing stores only after their identity/currentness has been proved.

### Restoring the exact user-specific redundant/frozen stack

Do this only after one functional binding is healthy. The redundant four-binding layout changes over time, so there is deliberately no permanent `3140`, `3137`, or other port constant in the disaster script.

1. Restore/read the Vault and load `04 Operating Contracts/mcp-current-topology.json`. Confirm `schema=mcp-current-topology.v1` and `authority=current_serving_topology`.
2. Verify the topology against live listeners/tasks and the source rollout PR/commit. If the machine was lost completely, treat the topology as the last durable desired state until live replacements are proved—not as proof that old PIDs/tasks still exist.
3. Preserve surviving OAuth stores, receipt stores, rollback artifacts, dirty worktrees, and unrelated processes. Never use task/instance names such as `test` or `debug` as disposal authority.
4. Recreate clean frozen candidates from the current source commit with `scripts/prepare-frozen-home-direct.ps1`. This script creates a hash-checked independent runtime and Scheduled Task but intentionally does **not** change Caddy routes. It requires explicit authorization, current topology, and existing OAuth state for the lane it starts. Use its `-Plan` mode first.
5. If OAuth for a redundant lane no longer exists, do not copy a backup or another lane's store. Restore one functional connector first, then re-establish that lane's authorization through the current connector/OAuth owner before starting a `-RequireExistingOAuthState` frozen task.
6. Restore the long-lived Caddy supervisor from `chatgpt/home-direct-stable-runtime`. Validate candidate Caddy config off-path. A healthy live Caddy main-backend retarget still requires the explicit retarget switch and Host `/mcp` proof; when owned Caddy is down/unhealthy, the supervisor may converge stale runtime routing to canonical only after the canonical backend returns the required unauthenticated Host `/mcp` contract.
7. Before any shared route change, use the existing Busy exact scope and production-change gate, preserve an independent rollback lane, and prove the candidate off-path. Do not restart shared Caddy merely to validate source/config; use temp config/Caddy simulation where possible.
8. Acceptance for each public route is not `/health` alone. Prove the exact public `Host` against `POST /mcp`; unauthenticated reachability should return the expected authorization response (currently 401 for the MCP contract), not 403/502. Verify runtime identity/source commit, process tool list, OAuth boundary, and loaded Caddy routes.

`scripts/prepare-frozen-home-direct.ps1` is an optional second-stage deployment primitive. A normal user does not need MCPXX, Supertest9001, MCPVisual, and MCPv4 simultaneously; one compatible healthy binding is the recovery minimum and normal operating requirement.

### Mandatory completion gate after MCP install, update, restore, or route cutover

An MCP change is not complete merely because health is green or Caddy points at the new port. Before reporting completion, reconcile the whole current-control surface:

1. Prove the serving bindings from live evidence: exact route, backend generation/source commit, three-tool contract, Scheduled Task owner, OAuth-store identity, and intended process receipt/control directory. Never assume sibling bindings share identities.
2. Prove Windows runtime hardening on every newly serving backend: CPU priority AboveNormal, memory priority 5, and execution-speed throttling disabled. Do not use High/Realtime, lock the whole heap, or raise user workloads.
3. For bootstrap aliases, request the normal large read and follow READ_SAME_PROCESS_ID until STOP_READING. Reconstruct the exact JSON and require bootstrap_end.status=COMPLETE. Large snapshots must use bounded lossless continuation pages.
4. Preserve old backends until running-process continuity is proved. Cross-backend read_output/kill_process requires the replacement to use the same receipt/control directory as the backend that owns those live processes. Do not kill foreign work to accelerate a cutover.
5. For a one-binding-at-a-time shared-production cutover, claim an exact Busy scope beginning mcp:binding: and use the production-change gate with rollback plus off-path proof. A broad Caddy/MCP scope does not qualify for guarded-binding rollout semantics.
6. Keep an independent rollback route healthy and preserve the immediately previous serving generation off-route until acceptance is complete. Never merge or copy OAuth stores as part of rollback.
7. Reconcile durable current state before the final answer: Vault mcp-current-topology.json, mcp-recovery-state.json, Stack Atlas metadata/tests, install/restore/update guidance, and the canonical agent/control contract that governs MCP changes.
8. Run a stale-current-reference audit for superseded serving ports, commits, task names, broad Busy scopes, and receipt-store assumptions in current docs/contracts. Do not rewrite dated incident reports, fixtures, or historical evidence.
9. When the Vault/Stack Atlas control layer changed, refresh its installed/runtime projection and re-run the relevant bootstrap/Atlas acceptance checks. A Git commit alone does not prove the local runtime copy changed.
10. Record rollback identity, validation evidence, and intentionally preserved old generations. Only then call the update or restore complete.

This checklist is the update procedure for future MCP generations. Port numbers and commits in examples are never durable authority.

### Validation after recovery

Run the installed doctor and check the control surfaces:

```powershell
pwsh -File "$env:LOCALAPPDATA\ChatGPTMcpStack\mcp\scripts\stack-doctor.ps1" `
  -ConfigPath "$env:LOCALAPPDATA\ChatGPTMcpStack\stack-config.json" `
  -RequireHealthyRuntime

& "$env:USERPROFILE\.agents\Get-AgentContract.ps1" -Id orientation.discovery
python "$env:USERPROFILE\Desktop\vault\tools\stack_atlas.py" lookup stack_atlas
```

When restoring this user's context, also verify that `VaultCheckoutSync`, `VaultBootstrapSnapshot`, and `VaultBootstrapSnapshotWatchdog` exist with known owner-installed actions. Then read `mcp-current-topology.json` again and compare it with exact local task/listener/Caddy evidence before calling the exact redundant topology restored.

### Information that GitHub cannot safely reconstruct

GitHub source can rebuild software, rules, instructions, and durable operating context, but it must not manufacture secrets or transient identity. The following require surviving local state or user/platform reauthorization: OAuth tokens/client registrations, private credentials, router/NAT credentials, and any owner identity intentionally not stored in GitHub. Missing credentials are a reauthorization event, not permission to copy stale backups.

## Local one-package install

`install.ps1` installs the home-direct stack on one Windows machine: the loopback MCP backend, local Caddy, standalone BusyCoordinator, the shared rules checkout, PlanOnly, and autostart. This installer does not provision or depend on a VPS, WireGuard, reverse SSH, or Tailscale owner authorization.

The connector surface stays exactly three tools: `start_process`, `read_output`, and `kill_process`. There is no separate vision, image-read, upload, proof-bridge, or widget tool. Visual artifacts ride the normal process result path; there is no ChatGPT-to-host file-import tool. Busy is installed beside MCP and is not exposed as an MCP tool.

**One compatible connector binding is the normal installation.** A user or deployment does not need MCPXX, Supertest9001, MCPVisual, and MCPv4 together. Those names are independent optional bindings used for redundancy, fallback/control, staged rollout, and parity/regression testing. Install/configure one supported binding for ordinary use; if several are present, use one healthy binding for the task and fan out across bindings only when explicitly testing cross-binding behavior. Native vision uses the same three-tool process-result contract on each compatible binding and never depends on the other bindings being installed.

From an elevated PowerShell 7 prompt in a clean clone, run `pwsh -File .\install.ps1 -PublicOrigin https://your-mcp.example -OwnerLogin you@example.com`. The default is agentless-compatible; add `-WithAgentEntrypoints` only when Codex/OpenCode pointer entrypoints are wanted. `-Plan` prints the complete mutation-free install plan. Caddy 2.11.3 is pinned and SHA-256 verified before installation, and the installer verifies the frozen three-tool MCP connector contract before promoting the runtime.

The package configures the same local-edge authorization model used by the home-direct setup: `/authorize` is accepted only through the local/private edge and otherwise fails closed. Internet reachability still requires the user's own router/DNS to deliver the public HTTPS endpoint to the installed local Caddy listener; the installer does not change router settings.

Run `pwsh -File .\scripts\stack-doctor.ps1` to verify the installation. `scripts\uninstall-stack.ps1` removes the managed runtime/tasks; Busy, rules, state, and the firewall rule are removed only with their explicit switches.

Process execution uses PowerShell 7 at `C:\Program Files\PowerShell\7\pwsh.exe` with no Windows PowerShell 5.1 fallback. The process preflight rejects drive-root recursive enumeration/search before spawn while allowing recursion under explicit project/subdirectory roots. Completed output retains up to 100,000 characters per stream and pages through the same `process_id` in 100,000-character logical pages. Explicit `start_process` and `read_output` waits are accepted up to 240 seconds, with transport request ceilings aligned above that wait.

When the local gh-buffer private proxies are installed under `%USERPROFILE%\.local\bin\gh-buffer-proxy`, `start_process` children automatically prepend that directory to their child-only PATH only if both `gh.exe` and `git.exe` are present. This makes raw noninteractive GitHub reads use gh-buffer while its conservative proxy rules preserve passthrough semantics for writes and unsupported Git operations. The MCP server environment and the user shell PATH are not modified. Set `MCP_GHBUF_PROXY_ENABLED=0` to disable child injection, or `MCP_GHBUF_PROXY_DIR=<path>` to use a different private proxy directory.
## Minimal redundant connector profile

For regression-research #125, the production-safe default is `MCP_TOOL_PROFILE=process`, exposing `start_process`, `read_output`, and `kill_process`. `MCP_TOOL_PROFILE=full` must be selected explicitly for internal/local tests. Minimal connector instances are stateless per MCP request, keep their OAuth/transport state separate, and may share the process receipt directory. Completed process receipts are readable through any clone and are copied into `shared-process-receipts/archive/YYYY-MM-DD/` for seven days; the flat 30-minute receipt cache remains only a fast handoff/read path. Completed responses and new durable receipts also expose `request_id` when available plus retained stdout/stderr character and UTF-8 byte counts, SHA-256 hashes, `evidence_completeness` (`complete` or `bounded` when capture truncated), and `execution_outcome`, allowing auditors to join `request_id -> caller_id -> process_id -> output evidence` without parsing raw output. These fields describe execution evidence completeness/integrity, not semantic work quality.

For reroute/security-routing acceptance work under #81, run `node scripts/analyze-reroute-acceptance.mjs <transport.jsonl> <mcp-security-routing-events.jsonl> <start-iso> <end-iso> [--bin-minutes 15]`. When the transport argument is the active `transport.jsonl`, the analyzer automatically includes its immutable `transport.jsonl.archive` segments and deduplicates repeated response/error rows by internal identifiers without emitting them. The report joins aggregate process-tool transport health with the bounded routing-event log without emitting raw caller/session/connection/request/process identifiers. Only records with `event_time_known=true` are assigned to an occurrence window; adverse reports with unknown occurrence time are surfaced separately and make the window indeterminate when their report time falls inside it. The process-tool summary includes first/last activity, observation span, and active-bin coverage so a later multi-day refreeze can distinguish sustained real use from a short burst. A clean observed window is evidence, not proof that a client-side reroute could not have occurred without an MCP request.

For an aggregate-only auditor view over durable receipts, run `node scripts/audit-process-evidence.mjs --receipt-dir <shared-process-receipts> --since-minutes 60`. The report deduplicates flat/archive copies by `process_id`, groups only by opaque `caller_id`, totals retained output bytes, completeness, execution outcomes, request-link coverage, audit-v1 schema coverage, SHA-256 verification state, and actual first/last receipt timestamps, and never emits raw stdout/stderr. It separately counts `process-output-evidence.v1` versus non-v1 receipts so historical or other-schema field absence is not automatically misread as a current evidence failure; v1-specific missing request/hash metadata remains visible. It deliberately does not map caller IDs to named workers or score semantic work quality. On upgrade, legacy flat receipts are archived before they are pruned. While a process is still running, cross-clone `read_output` and `kill_process` are relayed through a shared local control mailbox to the clone that actually owns the in-memory process. No backup clone kills a PID directly. BUSY/job coordination stays outside MCP in the standalone Rust/Python tool apps and is not duplicated into the connector.

Use `scripts/start-minimal-clone.ps1` to launch a minimal connector instance. `MCP_PUBLIC_ORIGIN` may include a path prefix when a distinct OAuth/resource identity is required.

Home-direct backend cutovers use `scripts/replace-home-direct-production.ps1` after an alternate-port candidate, independent rollback route, exact Busy claim, and production-change gate are proven; the script preserves the prior backend and rolls Caddy back automatically on failed route proof.
