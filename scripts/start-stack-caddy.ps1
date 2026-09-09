[CmdletBinding()]
param([string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpStack\stack-config.json'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "stack config not found: $ConfigPath" }
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$caddyExe = [IO.Path]::GetFullPath([string]$config.caddy_exe)
$caddyFile = [IO.Path]::GetFullPath([string]$config.caddy_config)
if (-not (Test-Path -LiteralPath $caddyExe -PathType Leaf)) { throw "Caddy executable missing: $caddyExe" }
if (-not (Test-Path -LiteralPath $caddyFile -PathType Leaf)) { throw "Caddy config missing: $caddyFile" }
& $caddyExe validate --config $caddyFile --adapter caddyfile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
while ($true) {
    & $caddyExe run --config $caddyFile --adapter caddyfile
    $code = $LASTEXITCODE
    if ($code -eq 0) { exit 0 }
    Write-Warning "Caddy exited unexpectedly (exit=$code); restarting in 2 seconds"
    Start-Sleep -Seconds 2
}
