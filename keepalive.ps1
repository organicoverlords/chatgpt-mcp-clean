param([int]$PollSeconds = 15)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
if ($PollSeconds -lt 5) { throw 'PollSeconds must be >= 5' }

function EnvValue([string]$Name) {
    if (-not (Test-Path '.env')) { return $null }
    $line = Get-Content '.env' | Where-Object { $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith('#') } | Select-Object -First 1
    if (-not $line) { return $null }
    return (($line -split '=',2)[1].Trim()).Trim("'").Trim('"')
}
$Port = [int]$(if (EnvValue 'PORT') { EnvValue 'PORT' } else { '3000' })
$Origin = EnvValue 'MCP_PUBLIC_ORIGIN'
$Tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
$State = Join-Path $Root '.state\keepalive'
New-Item -ItemType Directory -Force $State | Out-Null
$stdout = Join-Path $State 'server.stdout.log'; $stderr = Join-Path $State 'server.stderr.log'; $log = Join-Path $State 'supervisor.log'
function Log([string]$s) { Add-Content $log ((Get-Date).ToString('o')+' '+$s) -Encoding UTF8 }
function Healthy { try { (Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3).status -eq 'ok' } catch { $false } }
function PortOwner { $l = netstat -ano | Select-String ":$Port\s" | Select-String 'LISTENING' | Select-Object -First 1; if (-not $l) { return $null }; return [int](($l -replace '\s+',' ').ToString().Trim().Split(' ')[-1]) }
function StartServer {
    if (Healthy) { return }
    $owner = PortOwner
    if ($owner) { Log "port occupied by PID $owner while health is down; not killing it"; return }
    Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'start.ps1'),'-SkipBuild','-Port',[string]$Port) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
    Log 'started clean MCP child'
}
function EnsureFunnel {
    if (-not $Origin -or -not (Test-Path $Tailscale) -or -not (Healthy)) { return }
    try { $r=Invoke-RestMethod ($Origin.TrimEnd('/')+'/health') -TimeoutSec 5; if ($r.status -eq 'ok') { return } } catch {}
    & $Tailscale funnel --yes --bg --https=443 "http://127.0.0.1:$Port" | Out-Null
    if ($LASTEXITCODE -eq 0) { Log 'restored Tailscale funnel' } else { Log 'Tailscale funnel restore failed' }
}
$mutex = New-Object System.Threading.Mutex($false,'Global\CodexLocalMcpKeepAlive'); $held=$false
try {
    try { $held=$mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held=$true }
    if (-not $held) { exit 0 }
    Log 'clean MCP supervisor started'
    while ($true) { StartServer; if (Healthy) { EnsureFunnel }; Start-Sleep -Seconds $PollSeconds }
} finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
