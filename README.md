# ChatGPT MCP Clean

Self-hosted, authenticated Streamable HTTP MCP for a Windows machine. The supported packaged path gives an MCP client a deliberately small process-control surface and exact-byte file transfer with one local HTTPS stack.

The default ChatGPT connector contract is `MCP_TOOL_PROFILE=process`, exposing exactly `start_process`, `read_output`, `kill_process`, `upload_local_file`, and `download_chatgpt_file`. `MCP_TOOL_PROFILE=full` must be selected explicitly for internal/local tests.

## Start here

### Requirements

Use a Windows 10/11 host with PowerShell 7 (`pwsh.exe`), Node.js 20 or newer plus npm, Git, and Python. You also need a public HTTPS hostname that resolves to this machine or its router, plus the ability to forward public TCP 443 to TCP 8443 on the Windows host unless you override the Caddy HTTPS port.

Administrator rights are needed once if the installer must create the Windows Firewall rule. Caddy is downloaded from the pinned package in `stack/caddy-package.json` and verified by SHA-256. The public `organicoverlords/agents` rules repository is installed by default; agent entrypoints remain opt-in.

### Clone

```powershell
git clone https://github.com/organicoverlords/chatgpt-mcp-clean.git
cd chatgpt-mcp-clean
git switch master
```

The repository default branch is `master`.

### Preview before changing the machine

```powershell
pwsh -File .\install.ps1 `
  -PublicOrigin https://mcp.example.com `
  -OwnerLogin you@example.com `
  -Plan
```

`-Plan` validates the inputs and prints the intended actions without installing the stack.

### Install

Run the same command without `-Plan`. Use an elevated PowerShell 7 prompt unless the inbound firewall rule already exists and you intentionally pass `-SkipFirewall`.

```powershell
pwsh -File .\install.ps1 `
  -PublicOrigin https://mcp.example.com `
  -OwnerLogin you@example.com
```

The installer builds a clean tracked copy, installs the loopback MCP backend, local Caddy, standalone BusyCoordinator, and shared rules checkout, registers logon tasks by default, starts the services, runs the stack doctor, and prints JSON containing the resulting `mcp_url`.

With the example origin, the MCP URL is:

```text
https://mcp.example.com/mcp
```

Configure your MCP client with the emitted `mcp_url`.

The installer default backend port is `3022` and the default local Caddy HTTPS port is `8443`. These are package defaults, not claims about the repository owner's currently running deployment.

### Make the endpoint reachable

By default, forward public TCP 443 to TCP 8443 on the Windows host. DNS for `-PublicOrigin` must resolve to the public address that reaches that forward.

```text
MCP client -> HTTPS hostname:443 -> router/NAT -> Windows Caddy:8443 -> MCP backend:3022
```

The packaged installer does not require a VPS, WireGuard, reverse SSH, or Tailscale owner authorization.

### Verify

```powershell
pwsh -File .\scripts\stack-doctor.ps1 -RequireHealthyRuntime
```

A healthy install reports the config, five-tool profile, file-transfer contract, Caddy config, local runtime health, BusyCoordinator contract, rules checkout, and autostart state.

The connector should expose exactly:

| Tool | Purpose |
| --- | --- |
| `start_process` | Start a bounded local process and return a process receipt/result. |
| `read_output` | Read or wait for additional output from the same `process_id`. |
| `kill_process` | Terminate the owned background process tree. |
| `upload_local_file` | Expose one exact local file to the MCP client without transcoding. |
| `download_chatgpt_file` | Save one client-provided file to an explicit local destination without transcoding. |

Busy/job coordination is installed beside MCP but is deliberately not part of the public five-tool MCP surface.

## File transfer and process evidence

`upload_local_file` preserves source bytes and reports byte count plus SHA-256. Images remain exact file resources; a UI thumbnail is only a preview. `download_chatgpt_file` streams the client file to the requested absolute destination without transcoding and reports byte count plus SHA-256.

Process receipts retain bounded stdout/stderr plus integrity/completeness metadata. Completed receipts can be read across compatible connector clones through the shared receipt store. A running process remains owned by the clone that created it; cross-clone control is relayed rather than killing arbitrary PIDs.

## Security model

The packaged installer uses local-edge owner authorization. Caddy accepts `/authorize` only from private/local client addresses and returns 403 for other sources. Keep OAuth stores private and do not copy one installation's OAuth state over another.

The installer does not configure your router, DNS provider, or public-IP policy. The process boundary rejects drive-root recursive enumeration/search before spawn while allowing recursion under explicit project/subdirectory roots. PowerShell execution requires PowerShell 7; there is no Windows PowerShell 5.1 fallback.

## Update an installed stack

```powershell
git switch master
git pull --ff-only origin master
pwsh -File .\install.ps1 `
  -PublicOrigin https://mcp.example.com `
  -OwnerLogin you@example.com `
  -Plan
```

Review the plan, then rerun without `-Plan`. A real install requires a clean tracked source checkout and records the source commit plus the built `dist/index.js` hash in the installed config.

## Uninstall

Preview first:

```powershell
pwsh -File .\scripts\uninstall-stack.ps1 -WhatIf
```

Run the same command without `-WhatIf` to remove the managed MCP/Caddy runtime and scheduled tasks. Busy, the rules checkout, persistent state, and the firewall rule are preserved unless you explicitly pass `-RemoveBusy`, `-RemoveRules`, `-RemoveState`, or `-RemoveFirewall`.

## Useful install options

- `-WithAgentEntrypoints`: install Codex/OpenCode pointer entrypoints from the public rules checkout.
- `-SkipFirewall`: do not create the inbound Windows Firewall rule.
- `-NoAutostart`: do not register logon tasks.
- `-NoStart`: install/register without starting MCP/Caddy immediately.
- `-Port <n>`: override the loopback MCP backend port.
- `-CaddyHttpsPort <n>`: override the local Caddy HTTPS port.
- `-InstallRoot`, `-BusyRoot`, `-RulesRoot`: choose installation roots explicitly.
- `-RulesRepository`, `-RulesRef`: use a compatible rules repository/ref.

## Development

```powershell
npm ci
npm run build
npm test
```

The TypeScript/Node package is marked `private` to prevent accidental npm publication. That does not prevent cloning and running the repository.

Lightweight contract checks:

```powershell
node .\scripts\verify-process-contract.mjs
node .\scripts\check-readme-timeline.mjs
```

Advanced recovery and multi-instance scripts remain under `scripts/` because they preserve useful operational and regression evidence. They are not prerequisites for the supported one-package install above.

## Package docs versus deployment state

This repository is the software package, not a live-state registry. Values in old issues, changelog entries, frozen-runtime names, ports, VPS/WireGuard notes, and recovery scripts describe particular installations at particular times. Do not use those values as the current state of a different installation.

For a normal install, trust the installer options and the generated `stack-config.json` on that machine. Keep any separate live deployment inventory in its own current-state authority instead of rewriting package documentation whenever a backend value changes.

## License

This repository currently has no declared open-source license. The setup is documented for reproducibility, but redistribution/modification rights are not granted by a license file. The repository owner should choose and add a license explicitly before representing the project as open-source software.

<!-- PROJECT-TIMELINE:BEGIN -->
## Project timeline

- [2026-09-15] Reworked the public repository front door (#355): README now starts with prerequisites, plan/install/connect/verify/update/uninstall steps, separates installer defaults from deployment-specific live topology, and moves historical topology notes out of the onboarding path, and the PowerShell runtime regression test now accepts supported PowerShell 7 patch updates instead of pinning 7.6.5.
- [2026-09-10] Split lossless file transfer into explicit `upload_local_file` and `download_chatgpt_file` actions (#235): normal `start_process`/`read_output` no longer mount the Library widget, ChatGPT file inputs use native file params for direct streaming to disk, local uploads use exact-byte SHA-256 verification, and compressible HTTP transfers may use zstd level 1 while already-compressed media stays unchanged.
- [2026-09-10] Added the one-command local home-direct stack installer (#233): one Windows host gets the loopback MCP backend, pinned local Caddy, standalone BusyCoordinator, shared base rules, PlanOnly, and autostart; the ChatGPT connector remains exactly `start_process`, `read_output`, and `kill_process`, while Library delivery stays metadata/resource-widget behavior rather than a fourth tool.
- [2026-09-06] Made the three-process-tool ChatGPT connector profile the production-safe default, corrected stale full-profile documentation, and added a rotation-aware reroute acceptance analyzer that joins aggregate transport health with exact/unknown-time routing evidence without exposing raw identifiers (#81).
- [2026-09-05] Extended the public Caddy client idle timeout from 15 seconds to 5 minutes after packet/access-log correlation showed Caddy was closing otherwise healthy client connections at about 15 seconds; retained WireGuard-only backend routing and the 30-second/max-4 upstream keep-alive pool, and live proof reused the same TLS socket after 20 seconds idle.

See the canonical [CHANGELOG.md](CHANGELOG.md) for the complete project timeline.
<!-- PROJECT-TIMELINE:END -->
