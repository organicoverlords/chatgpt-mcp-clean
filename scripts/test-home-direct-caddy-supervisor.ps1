$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'home-direct-caddy-supervisor.ps1'
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$source = Get-Content -LiteralPath $scriptPath -Raw
foreach ($required in @('Get-CimInstance Win32_Process', 'Get-NetTCPConnection', 'caddy.exe', 'CaddyPath start', 'while ($true)', '[switch]$Once')) {
    if ($source -notmatch [regex]::Escape($required)) { throw "missing supervisor contract: $required" }
}
Write-Output 'PASS home_direct_caddy_supervisor syntax=ok crash_restart=present startup_once=present'
