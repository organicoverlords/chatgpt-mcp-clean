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
$ServerName = 'shell-mcp'
$Tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
$State = Join-Path $Root '.state\keepalive'
New-Item -ItemType Directory -Force $State | Out-Null
$stdout = Join-Path $State 'server.stdout.log'; $stderr = Join-Path $State 'server.stderr.log'; $log = Join-Path $State 'supervisor.log'
$PidFile = Join-Path $State 'child.pid'

# Hardening knobs.
$MaxLogBytes   = 5MB   # rotate supervisor.log past this
$MaxArchives   = 5     # keep this many server.std*.log archives
$RepeatFlush   = 60    # re-emit a stuck repeating message every N occurrences (~15min at 15s)
$BackoffMax    = 300   # cap the restart backoff at 5 minutes

$script:lastMsg = $null
$script:repeat = 0
$script:failStreak = 0

function RotateIfLarge([string]$Path) {
    try {
        if ((Test-Path $Path) -and ((Get-Item $Path).Length -gt $MaxLogBytes)) {
            Move-Item $Path "$Path.1" -Force
        }
    } catch {}
}

# Collapses consecutive identical messages instead of writing one line per poll.
# A permanently stuck condition logged once every 15s produced ~600 lines in 2h;
# now it logs once, then a periodic "repeated N times" heartbeat.
function Log([string]$s) {
    if ($s -eq $script:lastMsg) {
        $script:repeat++
        if ($script:repeat % $RepeatFlush -ne 0) { return }
        $s = "$s (repeated $($script:repeat) times)"
    } else {
        if ($script:repeat -gt 0 -and $script:lastMsg) {
            RotateIfLarge $log
            Add-Content $log ((Get-Date).ToString('o')+" previous message repeated $($script:repeat) time(s)") -Encoding UTF8
        }
        $script:lastMsg = $s
        $script:repeat = 0
    }
    RotateIfLarge $log
    Add-Content $log ((Get-Date).ToString('o')+' '+$s) -Encoding UTF8
}

# Identity-checked health. A bare {"status":"ok"} from some *other* service on this
# port previously satisfied this probe, so the supervisor believed the server was up,
# never started it, and pointed the public Funnel at the wrong process.
function Healthy { try { $r = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3; return ($r.status -eq 'ok' -and $r.name -eq $ServerName) } catch { $false } }
function PublicHealthy { if (-not $Origin) { return $false }; try { $r = Invoke-RestMethod ($Origin.TrimEnd('/')+'/health') -TimeoutSec 5; return ($r.status -eq 'ok' -and $r.name -eq $ServerName) } catch { $false } }

function FunnelConfigured {
    if (-not $Origin -or -not (Test-Path $Tailscale)) { return $false }
    try {
        $status = (& $Tailscale funnel status --json | ConvertFrom-Json)
        $hostKey = ([uri]$Origin).Host + ':443'
        $tcp443 = $status.TCP.'443'
        $webHost = $status.Web.$hostKey
        $handler = $webHost.Handlers.'/'
        $allowed = $status.AllowFunnel.$hostKey
        return ($tcp443.HTTPS -eq $true -and $handler.Proxy -eq "http://127.0.0.1:$Port" -and $allowed -eq $true)
    } catch { return $false }
}
function EnsureFunnelConfiguration {
    if (-not $Origin -or -not (Test-Path $Tailscale) -or -not (Healthy) -or (FunnelConfigured)) { return }
    & $Tailscale funnel --yes --bg --https=443 "http://127.0.0.1:$Port" | Out-Null
    if ($LASTEXITCODE -eq 0 -and (FunnelConfigured)) { Log 'restored policy-compliant Tailscale Funnel configuration' }
    else { Log 'Tailscale Funnel configuration repair failed' }
}

function PortOwner { $l = netstat -ano | Select-String ":$Port\s" | Select-String 'LISTENING' | Select-Object -First 1; if (-not $l) { return $null }; return [int](($l -replace '\s+',' ').ToString().Trim().Split(' ')[-1]) }

function RecordedPid { try { if (Test-Path $PidFile) { return [int](Get-Content $PidFile -Raw).Trim() } } catch {}; return 0 }

# Ownership test. The CommandLine probe alone is not sufficient: an elevated process
# reports a blank CommandLine to a non-elevated WMI query, so the supervisor's own
# server can read as "foreign" and the port is never reclaimed without a human. The
# recorded-PID check covers that case.
function IsOwnedMcpListener([int]$ProcessId) {
    if ($ProcessId -gt 0 -and $ProcessId -eq (RecordedPid)) { return $true }
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
        if (-not $proc -or $proc.Name -ne 'node.exe' -or $proc.CommandLine -notmatch 'dist[\\/]index\.js') { return $false }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)"
        if (-not $parent) { return $false }
        return $parent.CommandLine -like "*$Root\start.ps1*"
    } catch { return $false }
}

function ArchiveServerLogs {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    if (Test-Path $stdout) { Move-Item $stdout (Join-Path $State "server.stdout.$stamp.log") -Force }
    if (Test-Path $stderr) { Move-Item $stderr (Join-Path $State "server.stderr.$stamp.log") -Force }
    foreach ($prefix in @('server.stdout.','server.stderr.')) {
        Get-ChildItem $State -Filter "$prefix*.log" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -Skip $MaxArchives |
            ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
    }
}

function StartServer {
    if (Healthy) { $script:failStreak = 0; return }
    $owner = PortOwner
    if ($owner) {
        if (-not (IsOwnedMcpListener $owner)) { Log "port occupied by foreign PID $owner while health is down; not killing it"; return }
        Start-Sleep -Seconds 2
        if (Healthy) { $script:failStreak = 0; return }
        if ((PortOwner) -ne $owner) { return }
        Log "reclaiming unhealthy owned MCP listener PID $owner"
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        for ($i=0; $i -lt 20 -and (PortOwner); $i++) { Start-Sleep -Milliseconds 100 }
        if (PortOwner) { Log "owned MCP listener PID $owner did not release port"; return }
    }
    ArchiveServerLogs
    Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'start.ps1'),'-SkipBuild','-Port',[string]$Port) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null

    # Wait for the listener and record its PID, so a later reclaim does not depend on
    # reading a CommandLine we may not be privileged to see.
    $listener = $null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (Healthy) { $listener = PortOwner; break }
    }
    if ($listener) {
        Set-Content $PidFile ([string]$listener) -Encoding ASCII
        $script:failStreak = 0
        Log "started clean MCP child (listener PID $listener)"
    } else {
        $script:failStreak++
        Log "clean MCP child failed to become healthy (consecutive failures: $($script:failStreak))"
    }
}

$mutex = New-Object System.Threading.Mutex($false,'Global\CodexLocalMcpKeepAlive'); $held=$false
try {
    try { $held=$mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held=$true }
    if (-not $held) { exit 0 }
    Log 'clean MCP supervisor started'
    while ($true) {
        StartServer
        if (Healthy) {
            EnsureFunnelConfiguration
            if (-not (PublicHealthy)) { Log 'public MCP health probe failed while local MCP is healthy; persistent Funnel configuration left unchanged' }
        }
        # Exponential backoff on a server that will not come up, so a broken build does
        # not get relaunched every 15s indefinitely.
        $delay = $PollSeconds
        if ($script:failStreak -gt 0) {
            $delay = [Math]::Min($BackoffMax, $PollSeconds * [Math]::Pow(2, [Math]::Min(6, $script:failStreak)))
        }
        Start-Sleep -Seconds $delay
    }
} finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
