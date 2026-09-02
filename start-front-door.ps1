param(
    [int]$Port = 3003,
    [string]$BackendConfigPath = '',
    [string]$ProcessRoutePath = '',
    [string]$StaticRoutePath = '',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (Test-Path '.env') {
    foreach ($line in Get-Content -LiteralPath '.env') {
        $s = $line.Trim()
        if (-not $s -or $s.StartsWith('#') -or $s -notmatch '=') { continue }
        $name, $value = $s -split '=', 2
        Set-Item -Path "Env:$($name.Trim())" -Value $value.Trim().Trim("'").Trim('"')
    }
}
$env:FRONT_DOOR_PORT = [string]$Port
if ($BackendConfigPath) { $env:MCP_BACKEND_CONFIG_PATH = $BackendConfigPath }
if ($ProcessRoutePath) { $env:MCP_PROCESS_ROUTE_PATH = $ProcessRoutePath }
if ($StaticRoutePath) { $env:FRONT_DOOR_STATIC_ROUTE_PATH = $StaticRoutePath }
if (-not $SkipBuild) { & npm.cmd run build --silent; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& node.exe dist/front-door.js
exit $LASTEXITCODE
