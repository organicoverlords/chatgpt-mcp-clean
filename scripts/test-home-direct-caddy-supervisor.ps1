$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'home-direct-caddy-supervisor.ps1'
$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'config\home-direct.Caddyfile'
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$source = Get-Content -LiteralPath $scriptPath -Raw
foreach ($required in @('CanonicalConfigPath', 'MainPublicHost', 'MainBackendPort', 'Assert-CaddyConfigContract', 'Get-FileHash', 'Copy-Item', 'CaddyPath reload', 'while ($true)', '[switch]$Once')) {
    if ($source -notmatch [regex]::Escape($required)) { throw "missing supervisor contract: $required" }
}
$assertIndex = $source.IndexOf('Assert-CaddyConfigContract $CanonicalConfigPath')
$copyIndex = $source.IndexOf('Copy-Item -LiteralPath $CanonicalConfigPath')
if ($assertIndex -lt 0 -or $copyIndex -lt 0 -or $assertIndex -gt $copyIndex) { throw 'canonical route contract must be checked before config copy/reload' }
$config = Get-Content -LiteralPath $configPath -Raw
if ($config -match '(?i)header_up|tailscale-user-login|tailscale-funnel-request') { throw 'canonical home-direct Caddy config must not inject trust headers' }
if ($config -notmatch 'reverse_proxy\s+127\.0\.0\.1:3022') { throw 'canonical home-direct Caddy config must proxy to 3022' }

$temp = Join-Path ([IO.Path]::GetTempPath()) ('home-direct-caddy-guard-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $badConfig = Join-Path $temp 'bad.Caddyfile'
    $runtimeConfig = Join-Path $temp 'runtime.Caddyfile'
    @(
        '91-159-12-133.sslip.io {',
        '    handle {',
        '        reverse_proxy 127.0.0.1:3025',
        '    }',
        '}'
    ) | Set-Content -LiteralPath $badConfig -Encoding utf8
    $output = @(& pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -CanonicalConfigPath $badConfig -RuntimeConfigPath $runtimeConfig -CaddyPath (Join-Path $temp 'missing-caddy.exe') -Once 2>&1)
    if ($LASTEXITCODE -eq 0) { throw 'main-host retarget to 3025 must fail closed' }
    if (Test-Path -LiteralPath $runtimeConfig) { throw 'invalid canonical config must be rejected before runtime config copy' }
    if (($output -join "`n") -notmatch 'must proxy exclusively to 127\.0\.0\.1:3022') { throw "unexpected route-guard failure: $($output -join ' ')" }
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'PASS home_direct_caddy_supervisor canonical_sync=present auth_header_injection=absent main_route_guard=fail_closed proxy_3022=present'
