param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$InstanceId,
    [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
    [Parameter(Mandatory=$true)][string]$PublicOrigin,
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors'),
    [string]$SharedReceiptDirectory = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors\shared-process-receipts'),
    [string]$OAuthStorePath = '',
    [switch]$WireGuardCandidate,
    [switch]$ValidateOnly,
    [switch]$SkipBuild
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
$env:MCP_PUBLIC_ORIGIN = $PublicOrigin
$env:MCP_OAUTH_STORE_PATH = $OAuthStorePath
$env:MCP_TRANSPORT_LOG_PATH = Join-Path $instanceState 'transport.jsonl'
$env:MCP_PROCESS_RECEIPT_DIR = $SharedReceiptDirectory

if (-not $env:TAILSCALE_OWNER_LOGIN) { throw 'TAILSCALE_OWNER_LOGIN is required (normally supplied by .env)' }
if (-not $SkipBuild) { & npm.cmd run build --silent; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
$runtimeSourceCommit = (& git.exe -C $Root rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $runtimeSourceCommit -notmatch '^[0-9a-f]{40}$') { throw 'cannot bind MCP runtime source commit' }
$runtimeTrackedChanges = @(& git.exe -C $Root status --porcelain=v1 --untracked-files=no)
if ($LASTEXITCODE -ne 0) { throw 'cannot bind MCP runtime source cleanliness' }
$runtimeDistIndex = Join-Path $Root 'dist\index.js'
if (-not (Test-Path -LiteralPath $runtimeDistIndex -PathType Leaf)) { throw 'cannot bind MCP runtime dist identity: dist/index.js is missing' }
$runtimeDistSha256 = (Get-FileHash -LiteralPath $runtimeDistIndex -Algorithm SHA256).Hash.ToLowerInvariant()
$env:MCP_RUNTIME_INSTANCE_ID = $InstanceId
$env:MCP_RUNTIME_SOURCE_COMMIT = $runtimeSourceCommit
$env:MCP_RUNTIME_DIST_SHA256 = $runtimeDistSha256
$env:MCP_RUNTIME_SOURCE_DIRTY = if ($runtimeTrackedChanges.Count -gt 0) { '1' } else { '0' }
& node.exe scripts/verify-process-contract.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node.exe dist/index.js
exit $LASTEXITCODE
