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

$originUri = [uri]$PublicOrigin
$publicSlug = $originUri.AbsolutePath.Trim('/')
$expectedOAuthStore = if ($publicSlug) { Join-Path (Join-Path $StateRoot $publicSlug) 'oauth.json' } else { '' }
$canonicalStateRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors'))
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
& node.exe scripts/verify-process-contract.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node.exe dist/index.js
exit $LASTEXITCODE
