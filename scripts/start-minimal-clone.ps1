param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$InstanceId,
    [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
    [Parameter(Mandatory=$true)][string]$PublicOrigin,
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors'),
    [string]$SharedReceiptDirectory = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors\shared-process-receipts'),
    [string]$OAuthStorePath = '',
    [switch]$WireGuardCandidate,
    [switch]$ValidateOnly,
    [switch]$SkipBuild,
    [switch]$RestartOnUnexpectedExit,
    [ValidateRange(1,60)][int]$RestartBackoffSeconds = 2,
    [ValidateRange(0,1000)][int]$RestartLimit = 0,
    [ValidateRange(100,5000)][int]$GenerationProbeMilliseconds = 1000,
    [ValidateRange(2,10)][int]$GenerationSettleProbeCount = 3
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
function Set-McpRuntimePriority {
    $currentProcess = Get-Process -Id $PID
    $currentProcess.PriorityClass = 'Normal'
    if (-not ('McpRuntimePriorityNative' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class McpRuntimePriorityNative {
    [StructLayout(LayoutKind.Sequential)] public struct ProcessMemoryPriorityInfo { public uint MemoryPriority; }
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetProcessInformation(IntPtr process, int informationClass, ref ProcessMemoryPriorityInfo information, uint informationSize);
    [DllImport("ntdll.dll")] public static extern int NtSetInformationProcess(IntPtr process, int informationClass, ref uint information, uint informationSize);
}
"@
    }
    $memory = New-Object McpRuntimePriorityNative+ProcessMemoryPriorityInfo
    $memory.MemoryPriority = 5
    if (-not [McpRuntimePriorityNative]::SetProcessInformation($currentProcess.Handle, 0, [ref]$memory, [Runtime.InteropServices.Marshal]::SizeOf($memory))) {
        throw "failed to set MCP memory priority: win32=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $ioPriority = [uint32]2
    $ioStatus = [McpRuntimePriorityNative]::NtSetInformationProcess($currentProcess.Handle, 33, [ref]$ioPriority, 4)
    if ($ioStatus -ne 0) { throw ('failed to set MCP I/O priority: ntstatus=0x{0:X8}' -f ([uint32]$ioStatus)) }
}
Set-McpRuntimePriority

$originUri = [uri]$PublicOrigin
$publicSlug = $originUri.AbsolutePath.Trim('/')
$expectedOAuthStore = if ($publicSlug) { Join-Path (Join-Path $StateRoot $publicSlug) 'oauth.json' } else { '' }
$canonicalStateRoot = [IO.Path]::GetFullPath((Join-Path $Root 'minimal-connectors'))
$resolvedStateRoot = [IO.Path]::GetFullPath($StateRoot)
if ($WireGuardCandidate -and $Port -eq 3011) { throw 'WireGuard candidate must use an alternate port; canonical 3011 stays owned by the production listener' }
if ($resolvedStateRoot.Equals($canonicalStateRoot,[StringComparison]::OrdinalIgnoreCase)) {
    $trackedChanges = @(& git.exe -C $Root status --porcelain=v1 --untracked-files=no)
    if ($LASTEXITCODE -ne 0) { throw 'cannot verify source cleanliness for canonical clone launch' }
    if ($trackedChanges.Count -gt 0) { throw 'canonical clone launch requires a clean tracked source tree; preserve dirty work and launch from a clean worktree' }
}
if ($publicSlug -match '^clone-[A-Za-z0-9._-]+$') {
    if (-not $OAuthStorePath) { throw "replacement instance '$InstanceId' for '$publicSlug' must explicitly reuse the stable OAuth store" }
    $resolvedOAuthStore = [IO.Path]::GetFullPath($OAuthStorePath)
    $resolvedExpectedStore = [IO.Path]::GetFullPath($expectedOAuthStore)
    if (-not $resolvedOAuthStore.Equals($resolvedExpectedStore,[StringComparison]::OrdinalIgnoreCase)) { throw "replacement OAuth store must be the stable '$publicSlug' store" }
    if (-not (Test-Path -LiteralPath $resolvedExpectedStore -PathType Leaf)) { throw "stable OAuth store does not exist for '$publicSlug'" }
}
if ($ValidateOnly) { Write-Output 'IDENTITY_PREFLIGHT_OK'; exit 0 }

if (Test-Path '.env') {
    foreach ($line in Get-Content -LiteralPath '.env') {
        $s = $line.Trim()
        if (-not $s -or $s.StartsWith('#') -or $s -notmatch '=') { continue }
        $name, $value = $s -split '=', 2
        if (-not (Test-Path "Env:$($name.Trim())")) {
            Set-Item -Path "Env:$($name.Trim())" -Value $value.Trim().Trim("'").Trim('"')
        }
    }
}

$instanceState = Join-Path $StateRoot $InstanceId
New-Item -ItemType Directory -Force -Path $instanceState,$SharedReceiptDirectory | Out-Null
if (-not $OAuthStorePath) { $OAuthStorePath = Join-Path $instanceState 'oauth.json' }
$oauthDirectory = Split-Path -Parent $OAuthStorePath
if ($oauthDirectory) { New-Item -ItemType Directory -Force -Path $oauthDirectory | Out-Null }
& (Join-Path $Root 'scripts\protect-oauth-state.ps1') -OAuthStorePath $OAuthStorePath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:PORT = [string]$Port
$env:HOST = if ($WireGuardCandidate) { '10.203.0.2' } else { '127.0.0.1' }
$env:MCP_WIREGUARD_CANDIDATE = if ($WireGuardCandidate) { '1' } else { '0' }
$env:MCP_BACKEND_MODE = '1'
$env:MCP_TOOL_PROFILE = 'process'
$env:MCP_VISUAL_PROOF_UI = '0'
$env:MCP_VISUAL_PROOF_REVIEW = '0'
$env:MCP_PUBLIC_ORIGIN = $PublicOrigin
$env:MCP_OAUTH_STORE_PATH = $OAuthStorePath
$env:MCP_TRANSPORT_LOG_PATH = Join-Path $instanceState 'transport.jsonl'
$env:MCP_PROCESS_RECEIPT_DIR = $SharedReceiptDirectory

if (-not $env:TAILSCALE_OWNER_LOGIN) { throw 'TAILSCALE_OWNER_LOGIN is required (normally supplied by .env)' }
if (-not $SkipBuild) { & npm.cmd run build --silent; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
$runtimeDistIndex = Join-Path $Root 'dist\index.js'
$launcherLog = Join-Path $instanceState 'launcher-supervisor.jsonl'
$healthHost = if ($WireGuardCandidate) { '10.203.0.2' } else { '127.0.0.1' }
$healthUri = "http://${healthHost}:${Port}/health"

function Get-RuntimeGeneration {
    try {
        $sourceCommitOutput = @(& git.exe -C $Root rev-parse HEAD 2>$null)
        if ($LASTEXITCODE -ne 0 -or $sourceCommitOutput.Count -ne 1) { return $null }
        $sourceCommit = ([string]$sourceCommitOutput[0]).Trim().ToLowerInvariant()
        if ($sourceCommit -notmatch '^[0-9a-f]{40}$') { return $null }
        if (-not (Test-Path -LiteralPath $runtimeDistIndex -PathType Leaf)) { return $null }
        $distSha256 = (Get-FileHash -LiteralPath $runtimeDistIndex -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($distSha256 -notmatch '^[0-9a-f]{64}$') { return $null }
        return [pscustomobject]@{ source_commit = $sourceCommit; dist_sha256 = $distSha256 }
    } catch {
        return $null
    }
}

function Get-RuntimeIdentity {
    $generation = Get-RuntimeGeneration
    if (-not $generation) { return $null }
    try {
        $trackedChanges = @(& git.exe -C $Root status --porcelain=v1 --untracked-files=no 2>$null)
        if ($LASTEXITCODE -ne 0) { return $null }
        return [pscustomobject]@{
            source_commit = [string]$generation.source_commit
            dist_sha256 = [string]$generation.dist_sha256
            source_dirty = ($trackedChanges.Count -gt 0)
        }
    } catch {
        return $null
    }
}

function Set-RuntimeIdentityEnvironment([object]$Identity) {
    $env:MCP_RUNTIME_INSTANCE_ID = $InstanceId
    $env:MCP_RUNTIME_SOURCE_COMMIT = [string]$Identity.source_commit
    $env:MCP_RUNTIME_DIST_SHA256 = [string]$Identity.dist_sha256
    $env:MCP_RUNTIME_SOURCE_DIRTY = if ($Identity.source_dirty) { '1' } else { '0' }
}

function Write-LauncherEvent([hashtable]$Event) {
    try {
        $payload = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); instance_id = $InstanceId; port = $Port }
        foreach ($key in $Event.Keys) { $payload[$key] = $Event[$key] }
        Add-Content -LiteralPath $launcherLog -Value ($payload | ConvertTo-Json -Compress) -Encoding UTF8
    } catch {
        # Launcher telemetry must never become a new outage source.
    }
}

function Get-DirectChildren([int]$ParentPid) {
    return @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentPid" -ErrorAction SilentlyContinue)
}

function Test-ChildIdle([int]$ChildPid) {
    try {
        $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
        if (-not $health -or [int]$health.pid -ne $ChildPid) { return $false }
        if ([int]$health.active_requests -ne 0 -or [int]$health.live_process_count -ne 0) { return $false }
        if ((Get-DirectChildren $ChildPid).Count -ne 0) { return $false }
        return $true
    } catch {
        return $false
    }
}

$runtimeIdentity = Get-RuntimeIdentity
if (-not $runtimeIdentity) { throw 'cannot bind MCP runtime source/dist identity' }
Set-RuntimeIdentityEnvironment $runtimeIdentity
& node.exe scripts/verify-process-contract.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$restartCount = 0
while ($true) {
    $childStartedAt = [DateTimeOffset]::UtcNow
    $child = Start-Process -FilePath $nodePath -ArgumentList @('dist/index.js') -WorkingDirectory $Root -PassThru -NoNewWindow
    $generationRestart = $false
    $nextIdentity = $null
    $candidateKey = ''
    $candidateSeen = 0
    $candidateLogged = ''

    while (-not $child.HasExited) {
        Start-Sleep -Milliseconds $GenerationProbeMilliseconds
        $candidate = Get-RuntimeGeneration
        if (-not $candidate) {
            $candidateKey = ''
            $candidateSeen = 0
            continue
        }
        $changed = ([string]$candidate.source_commit -ne [string]$runtimeIdentity.source_commit) -or ([string]$candidate.dist_sha256 -ne [string]$runtimeIdentity.dist_sha256)
        if (-not $changed) {
            $candidateKey = ''
            $candidateSeen = 0
            $candidateLogged = ''
            continue
        }

        $observedKey = "{0}:{1}" -f $candidate.source_commit,$candidate.dist_sha256
        if ($observedKey -eq $candidateKey) { $candidateSeen++ } else { $candidateKey = $observedKey; $candidateSeen = 1 }
        if ($candidateSeen -lt $GenerationSettleProbeCount) { continue }
        $verifiedCandidate = Get-RuntimeIdentity
        if (-not $verifiedCandidate) { continue }
        if ([string]$verifiedCandidate.source_commit -ne [string]$candidate.source_commit -or [string]$verifiedCandidate.dist_sha256 -ne [string]$candidate.dist_sha256) { continue }
        if ($candidateLogged -ne $observedKey) {
            Write-LauncherEvent @{
                event = 'generation_change_detected'
                old_source_commit = [string]$runtimeIdentity.source_commit
                new_source_commit = [string]$verifiedCandidate.source_commit
                old_dist_sha256 = [string]$runtimeIdentity.dist_sha256
                new_dist_sha256 = [string]$verifiedCandidate.dist_sha256
                new_source_dirty = [bool]$verifiedCandidate.source_dirty
            }
            $candidateLogged = $observedKey
        }
        if ($verifiedCandidate.source_dirty) { continue }
        if (-not (Test-ChildIdle $child.Id)) { continue }

        Write-LauncherEvent @{
            event = 'generation_change_restart'
            old_source_commit = [string]$runtimeIdentity.source_commit
            new_source_commit = [string]$verifiedCandidate.source_commit
            old_dist_sha256 = [string]$runtimeIdentity.dist_sha256
            new_dist_sha256 = [string]$verifiedCandidate.dist_sha256
            child_pid = $child.Id
        }
        Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
        [void]$child.WaitForExit(5000)
        $nextIdentity = $verifiedCandidate
        $generationRestart = $true
        break
    }

    if (-not $child.HasExited) { $child.WaitForExit() }
    $childExitCode = if ($child.HasExited) { $child.ExitCode } else { 1 }
    $childRuntimeSeconds = [Math]::Max(0, ([DateTimeOffset]::UtcNow - $childStartedAt).TotalSeconds)

    if ($generationRestart) {
        $runtimeIdentity = $nextIdentity
        Set-RuntimeIdentityEnvironment $runtimeIdentity
        & node.exe scripts/verify-process-contract.mjs
        if ($LASTEXITCODE -ne 0) {
            Write-LauncherEvent @{ event = 'generation_change_contract_rejected'; source_commit = [string]$runtimeIdentity.source_commit; dist_sha256 = [string]$runtimeIdentity.dist_sha256; exit_code = $LASTEXITCODE }
            exit $LASTEXITCODE
        }
        $restartCount = 0
        continue
    }

    if (-not $RestartOnUnexpectedExit -or $childExitCode -eq 0) { exit $childExitCode }
    if ($childRuntimeSeconds -ge 30) { $restartCount = 0 }
    $restartCount++
    if ($RestartLimit -gt 0 -and $restartCount -gt $RestartLimit) {
        Write-LauncherEvent @{ event = 'restart_limit_exhausted'; child_exit_code = $childExitCode; child_runtime_seconds = [Math]::Round($childRuntimeSeconds,3); restart_count = $restartCount - 1 }
        exit $childExitCode
    }
    $delaySeconds = [Math]::Min(60, [int]($RestartBackoffSeconds * [Math]::Pow(2, [Math]::Min(5, $restartCount - 1))))
    Write-LauncherEvent @{ event = 'unexpected_child_exit'; child_exit_code = $childExitCode; child_runtime_seconds = [Math]::Round($childRuntimeSeconds,3); restart_count = $restartCount; restart_delay_seconds = $delaySeconds }
    Start-Sleep -Seconds $delaySeconds
}
