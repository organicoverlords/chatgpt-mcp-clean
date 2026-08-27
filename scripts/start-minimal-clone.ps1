param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$InstanceId,
    [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
    [Parameter(Mandatory=$true)][string]$PublicOrigin,
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors'),
    [string]$SharedReceiptDirectory = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors\shared-process-receipts'),
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

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
$env:PORT = [string]$Port
$env:HOST = '127.0.0.1'
$env:MCP_BACKEND_MODE = '1'
$env:MCP_TOOL_PROFILE = 'process'
$env:MCP_PUBLIC_ORIGIN = $PublicOrigin
$env:MCP_OAUTH_STORE_PATH = Join-Path $instanceState 'oauth.json'
$env:MCP_TRANSPORT_LOG_PATH = Join-Path $instanceState 'transport.jsonl'
$env:MCP_PROCESS_RECEIPT_DIR = $SharedReceiptDirectory

if (-not $env:TAILSCALE_OWNER_LOGIN) { throw 'TAILSCALE_OWNER_LOGIN is required (normally supplied by .env)' }
if (-not $SkipBuild) { & npm.cmd run build --silent; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& node.exe dist/index.js
exit $LASTEXITCODE
