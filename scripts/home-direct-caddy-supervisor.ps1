param(
    [string]$CaddyPath = (Join-Path $env:LOCALAPPDATA 'Caddy\mcp-home-test\caddy.exe'),
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'Caddy\mcp-home-test\Caddyfile'),
    [ValidateRange(1024,65535)][int]$Port = 8443,
    [ValidateRange(5,300)][int]$PollSeconds = 15,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'

function Get-OwnedCaddy {
    $configPattern = [regex]::Escape($ConfigPath)
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

function Start-Caddy {
    if (Test-CaddyHealthy) { return }
    $existing = Get-OwnedCaddy
    if ($existing) {
        Stop-Process -Id ([int]$existing.ProcessId) -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path -LiteralPath $CaddyPath -PathType Leaf)) { throw "Caddy executable is missing: $CaddyPath" }
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Caddy config is missing: $ConfigPath" }
    & $CaddyPath validate --config $ConfigPath --adapter caddyfile | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Caddy configuration validation failed' }
    & $CaddyPath start --config $ConfigPath --adapter caddyfile | Out-Null
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
