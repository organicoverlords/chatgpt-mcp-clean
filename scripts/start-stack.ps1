[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpStack\stack-config.json'),
    [ValidateRange(1,60)][int]$RestartBackoffSeconds = 2
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "stack config not found: $ConfigPath"
}
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$mcpRoot = [IO.Path]::GetFullPath([string]$config.mcp_root)
if (-not (Test-Path -LiteralPath (Join-Path $mcpRoot 'dist\index.js') -PathType Leaf)) {
    throw "installed MCP runtime is incomplete: $mcpRoot"
}

$stateRoot = [IO.Path]::GetFullPath([string]$config.state_root)
$instanceState = Join-Path $stateRoot ([string]$config.instance_id)
$receipts = Join-Path $stateRoot 'shared-process-receipts'
New-Item -ItemType Directory -Force -Path $stateRoot,$instanceState,$receipts | Out-Null

$env:PORT = [string]$config.port
$env:HOST = '127.0.0.1'
$env:MCP_BACKEND_MODE = '1'
$env:MCP_WIREGUARD_CANDIDATE = '0'
$env:MCP_TOOL_PROFILE = 'process'
$env:MCP_VISUAL_PROOF_UI = '0'
$env:MCP_VISUAL_PROOF_REVIEW = '0'
$env:MCP_PUBLIC_ORIGIN = [string]$config.public_origin
$env:MCP_OWNER_AUTH_ORIGIN = ''
$env:MCP_OWNER_AUTH_MODE = 'local-edge'
$env:TAILSCALE_OWNER_LOGIN = [string]$config.owner_login
$env:MCP_OAUTH_STORE_PATH = Join-Path $instanceState 'oauth.json'
$env:MCP_TRANSPORT_LOG_PATH = Join-Path $instanceState 'transport.jsonl'
$env:MCP_PROCESS_RECEIPT_DIR = $receipts
$env:MCP_RUNTIME_INSTANCE_ID = [string]$config.instance_id
if ($config.source_commit) { $env:MCP_RUNTIME_SOURCE_COMMIT = [string]$config.source_commit }
if ($config.dist_sha256) { $env:MCP_RUNTIME_DIST_SHA256 = [string]$config.dist_sha256 }
$env:MCP_RUNTIME_SOURCE_DIRTY = '0'

Set-Location $mcpRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
while ($true) {
    & $node (Join-Path $mcpRoot 'dist\index.js')
    $code = $LASTEXITCODE
    if ($code -eq 0) { exit 0 }
    Write-Warning "MCP runtime exited unexpectedly (exit=$code); restarting in $RestartBackoffSeconds seconds"
    Start-Sleep -Seconds $RestartBackoffSeconds
}
