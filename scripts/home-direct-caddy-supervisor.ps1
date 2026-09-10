param(
    [string]$CaddyPath = (Join-Path $env:LOCALAPPDATA 'Caddy\mcp-home-test\caddy.exe'),
    [string]$RuntimeConfigPath = (Join-Path $env:LOCALAPPDATA 'Caddy\mcp-home-test\Caddyfile'),
    [string]$CanonicalConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'config\home-direct.Caddyfile'),
    [string]$MainPublicHost = '91-159-12-133.sslip.io',
    [ValidateRange(1024,65535)][int]$MainBackendPort = 3022,
    [ValidateRange(1024,65535)][int]$Port = 8443,
    [ValidateRange(5,300)][int]$PollSeconds = 15,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'

function Get-OwnedCaddy {
    $configPattern = [regex]::Escape($RuntimeConfigPath)
    return @(Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match $configPattern } |
        Select-Object -First 1)
}

function Test-CaddyHealthy {
    $process = Get-OwnedCaddy
    if (-not $process) { return $false }
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    return @($listeners | Where-Object { [int]$_.OwningProcess -eq [int]$process.ProcessId }).Count -gt 0
}

function Get-CaddySiteBlock([string]$ConfigText, [string]$HostName) {
    $lines = @($ConfigText -split "`r?`n")
    $capturing = $false
    $depth = 0
    $buffer = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $lines) {
        if (-not $capturing) {
            if ($line.Trim() -ne "$HostName {") { continue }
            $capturing = $true
        }
        [void]$buffer.Add($line)
        $depth += [regex]::Matches($line, '\{').Count
        $depth -= [regex]::Matches($line, '\}').Count
        if ($capturing -and $depth -eq 0) { break }
    }
    if (-not $capturing -or $depth -ne 0) { return $null }
    return ($buffer -join "`n")
}

function Assert-CaddyConfigContract([string]$Path) {
    $config = Get-Content -LiteralPath $Path -Raw
    if ($config -match '(?i)header_up|tailscale-user-login|tailscale-funnel-request') {
        throw 'Canonical home-direct Caddy config must not inject trust headers'
    }
    $mainBlock = Get-CaddySiteBlock -ConfigText $config -HostName $MainPublicHost
    if (-not $mainBlock) { throw "Canonical home-direct Caddy config is missing main host block: $MainPublicHost" }
    $upstreams = @([regex]::Matches($mainBlock, '(?im)^\s*reverse_proxy\s+([^\s#]+)') | ForEach-Object { $_.Groups[1].Value })
    $expected = "127.0.0.1:$MainBackendPort"
    if ($upstreams.Count -eq 0 -or @($upstreams | Where-Object { $_ -ne $expected }).Count -gt 0) {
        throw "Canonical main host $MainPublicHost must proxy exclusively to $expected"
    }
}

function Sync-CaddyConfig {
    if (-not (Test-Path -LiteralPath $CanonicalConfigPath -PathType Leaf)) { throw "Canonical Caddy config is missing: $CanonicalConfigPath" }
    Assert-CaddyConfigContract $CanonicalConfigPath
    $runtimeDirectory = Split-Path -Parent $RuntimeConfigPath
    if ($runtimeDirectory) { New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null }
    $needsSync = -not (Test-Path -LiteralPath $RuntimeConfigPath -PathType Leaf)
    if (-not $needsSync) {
        $canonicalHash = (Get-FileHash -LiteralPath $CanonicalConfigPath -Algorithm SHA256).Hash
        $runtimeHash = (Get-FileHash -LiteralPath $RuntimeConfigPath -Algorithm SHA256).Hash
        $needsSync = $canonicalHash -ne $runtimeHash
    }
    if (-not $needsSync) { return }
    Copy-Item -LiteralPath $CanonicalConfigPath -Destination $RuntimeConfigPath -Force
    if (Test-CaddyHealthy) {
        & $CaddyPath reload --config $RuntimeConfigPath --adapter caddyfile | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Caddy configuration reload failed' }
    }
}

function Start-Caddy {
    Sync-CaddyConfig
    if (Test-CaddyHealthy) { return }
    $existing = Get-OwnedCaddy
    if ($existing) {
        Stop-Process -Id ([int]$existing.ProcessId) -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path -LiteralPath $CaddyPath -PathType Leaf)) { throw "Caddy executable is missing: $CaddyPath" }
    & $CaddyPath validate --config $RuntimeConfigPath --adapter caddyfile | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Caddy configuration validation failed' }
    & $CaddyPath start --config $RuntimeConfigPath --adapter caddyfile | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Caddy failed to start: exit=$LASTEXITCODE" }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-CaddyHealthy) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "Caddy did not open port $Port"
}

if ($Once) {
    Start-Caddy
    Write-Output "CADDY_SUPERVISOR_OK port=$Port"
    exit 0
}

while ($true) {
    try { Start-Caddy } catch { Write-Error $_ }
    Start-Sleep -Seconds $PollSeconds
}
