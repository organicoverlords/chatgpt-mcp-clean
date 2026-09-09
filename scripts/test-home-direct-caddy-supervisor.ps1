$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'home-direct-caddy-supervisor.ps1'
$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'config\home-direct.Caddyfile'
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$source = Get-Content -LiteralPath $scriptPath -Raw
foreach ($required in @('CanonicalConfigPath', 'Get-FileHash', 'Copy-Item', 'CaddyPath reload', 'while ($true)', '[switch]$Once')) {
    if ($source -notmatch [regex]::Escape($required)) { throw "missing supervisor contract: $required" }
}
$config = Get-Content -LiteralPath $configPath -Raw
if ($config -match '(?i)header_up|tailscale-user-login|tailscale-funnel-request') { throw 'canonical home-direct Caddy config must not inject trust headers' }
if ($config -notmatch 'reverse_proxy\s+127\.0\.0\.1:3022') { throw 'canonical home-direct Caddy config must proxy to 3022' }
Write-Output 'PASS home_direct_caddy_supervisor canonical_sync=present auth_header_injection=absent proxy_3022=present'
