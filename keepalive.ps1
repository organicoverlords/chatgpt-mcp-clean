param(
    [ValidateSet('FrontDoor','Backend','Legacy')][string]$Role = 'FrontDoor',
    [int]$Port = 0,
    [int]$PollSeconds = 15,
    [string]$BackendConfigPath = '',
    [string]$ProcessRoutePath = '',
    [string]$SupervisorStateRoot = '',
    [switch]$TestMode
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
if ($PollSeconds -lt 5) { throw 'PollSeconds must be >= 5' }
if ($Port -le 0) { $Port = if ($Role -eq 'FrontDoor') { 3003 } elseif ($Role -eq 'Legacy') { 3000 } else { 3001 } }
if ($Role -eq 'FrontDoor' -and $Port -ne 3003 -and -not $TestMode) { throw 'The public front door must own the stable 127.0.0.1:3003 endpoint outside explicit off-path tests' }
if ($Role -eq 'Backend' -and $Port -eq 3000) { throw 'A replaceable backend must not own the public front-door port' }

function EnvValue([string]$Name) {
    if (-not (Test-Path '.env')) { return $null }
    $line = Get-Content '.env' | Where-Object { $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith('#') } | Select-Object -First 1
    if (-not $line) { return $null }
    return (($line -split '=',2)[1].Trim()).Trim("'").Trim('"')
}

$Origin = EnvValue 'MCP_PUBLIC_ORIGIN'
$ServerName = 'shell-mcp'
$ExpectedRole = if ($Role -eq 'FrontDoor') { 'front-door' } elseif ($Role -eq 'Legacy') { 'direct' } else { 'backend' }
$Tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not $BackendConfigPath) { $BackendConfigPath = Join-Path $Root '.state\front-door\active-backend.json' }
if (-not $ProcessRoutePath) { $ProcessRoutePath = Join-Path $Root '.state\front-door\process-routes.json' }
$RoleKey = if ($Role -eq 'FrontDoor') { 'front-door' } elseif ($Role -eq 'Legacy') { 'legacy-3000' } else { "backend-$Port" }
if (-not $SupervisorStateRoot) { $SupervisorStateRoot = Join-Path $Root '.state\keepalive' }
$State = Join-Path $SupervisorStateRoot $RoleKey
New-Item -ItemType Directory -Force $State | Out-Null
$Log = Join-Path $State 'supervisor.log'
$PidFile = Join-Path $State 'child.pid'
$MaxLogBytes = 5MB
$MaxArchives = 5
$RepeatFlush = 60
$BackoffMax = 300
$OwnerFailureThreshold = 3
$HealthRecheckSeconds = 2
$script:lastMsg = $null
$script:repeat = 0
$script:failStreak = 0
$script:ownedHealthFailures = 0

function RotateIfLarge([string]$Path) {
    try { if ((Test-Path $Path) -and ((Get-Item $Path).Length -gt $MaxLogBytes)) { Move-Item $Path "$Path.1" -Force } } catch {}
}
function Log([string]$Message) {
    if ($Message -eq $script:lastMsg) {
        $script:repeat++
        if ($script:repeat % $RepeatFlush -ne 0) { return }
        $Message = "$Message (repeated $($script:repeat) times)"
    } else {
        if ($script:repeat -gt 0 -and $script:lastMsg) {
            RotateIfLarge $Log
            Add-Content $Log ((Get-Date).ToString('o')+" previous message repeated $($script:repeat) time(s)") -Encoding UTF8
        }
        $script:lastMsg = $Message
        $script:repeat = 0
    }
    RotateIfLarge $Log
    Add-Content $Log ((Get-Date).ToString('o')+' '+$Message) -Encoding UTF8
}

function Healthy {
    try {
        $response = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3
        if ($response.status -ne 'ok' -or $response.name -ne $ServerName -or [int]$response.port -ne $Port) { return $false }
        if ($Role -eq 'Backend') { return ($response.role -eq $ExpectedRole) }
        if ($Role -eq 'Legacy') { return (-not $response.role -or $response.role -eq 'direct') }
        return ([int]$response.pid -eq (PortOwner) -and (IsOwnedListener ([int]$response.pid)))
    } catch { return $false }
}
function PublicHealthy {
    if ($Role -ne 'FrontDoor' -or -not $Origin) { return $false }
    try {
        $response = Invoke-RestMethod ($Origin.TrimEnd('/')+'/health') -TimeoutSec 5
        return ($response.status -eq 'ok' -and $response.name -eq $ServerName -and [int]$response.port -eq $Port)
    } catch { return $false }
}
function FunnelConfigured {
    if ($TestMode -or $Role -ne 'FrontDoor' -or -not $Origin -or -not (Test-Path $Tailscale)) { return $false }
    try {
        $status = (& $Tailscale funnel status --json | ConvertFrom-Json)
        $hostKey = ([uri]$Origin).Host + ':443'
        return ($status.TCP.'443'.HTTPS -eq $true -and $status.Web.$hostKey.Handlers.'/'.Proxy -eq "http://127.0.0.1:$Port" -and $status.AllowFunnel.$hostKey -eq $true)
    } catch { return $false }
}
function EnsureFunnelConfiguration {
    if ($TestMode -or $Role -ne 'FrontDoor' -or -not $Origin -or -not (Test-Path $Tailscale) -or -not (Healthy) -or (FunnelConfigured)) { return }
    & $Tailscale funnel --yes --bg --https=443 "http://127.0.0.1:$Port" | Out-Null
    if ($LASTEXITCODE -eq 0 -and (FunnelConfigured)) { Log 'restored Tailscale Funnel to the stable front door' }
    else { Log 'Tailscale Funnel configuration repair failed' }
}

function PortOwner {
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { return [int]$listener.OwningProcess }
    return $null
}
function RecordedPid { try { if (Test-Path $PidFile) { return [int](Get-Content $PidFile -Raw).Trim() } } catch {}; return 0 }
function IsOwnedListener([int]$ProcessId) {
    if ($ProcessId -gt 0 -and $ProcessId -eq (RecordedPid)) { return $true }
    $entryPattern = if ($Role -eq 'FrontDoor') { 'dist[\\/]front-door\.js' } else { 'dist[\\/]index\.js' }
    $parentPattern = if ($Role -eq 'FrontDoor') { 'start-front-door\.ps1' } else { 'start\.ps1' }
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
        if (-not $process -or $process.Name -ne 'node.exe' -or $process.CommandLine -notmatch $entryPattern) { return $false }
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ParentProcessId)"
        return [bool]($parent -and $parent.CommandLine -match $parentPattern)
    } catch { return $false }
}
function ChildLogPath([string]$Prefix) {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
    return (Join-Path $State "$Prefix.$stamp.$([guid]::NewGuid().ToString('N')).log")
}
function ArchiveChildLogs {
    try {
        foreach ($prefix in @('child.stdout.','child.stderr.')) {
            Get-ChildItem $State -Filter "$prefix*.log" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -Skip $MaxArchives |
                ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
        }
    } catch {}
}

function StartChild {
    if (Healthy) { $script:failStreak = 0; $script:ownedHealthFailures = 0; return }
    if ($Role -eq 'FrontDoor' -and -not (Test-Path $BackendConfigPath)) {
        Log "front-door backend config is absent; refusing to bind the stable port before a candidate backend is configured"
        return
    }
    $owner = PortOwner
    if ($owner) {
        if (-not (IsOwnedListener $owner)) { Log "port $Port is occupied by foreign PID $owner while $Role health is down; not killing it"; return }
        $script:ownedHealthFailures++
        if ($script:ownedHealthFailures -lt $OwnerFailureThreshold) { Log "owned $Role listener PID $owner failed health ($($script:ownedHealthFailures)/$OwnerFailureThreshold); retaining it"; return }
        Start-Sleep -Seconds $HealthRecheckSeconds
        if (Healthy) { $script:failStreak = 0; $script:ownedHealthFailures = 0; return }
        if ((PortOwner) -ne $owner) { return }
        Log "reclaiming unhealthy owned $Role listener PID $owner"
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        for ($attempt=0; $attempt -lt 20 -and (PortOwner); $attempt++) { Start-Sleep -Milliseconds 100 }
        if (PortOwner) { Log "owned $Role listener PID $owner did not release port $Port"; return }
    }
    ArchiveChildLogs
    $stdout = ChildLogPath 'child.stdout'
    $stderr = ChildLogPath 'child.stderr'
    if ($Role -eq 'FrontDoor') {
        $startScript = Join-Path $Root 'start-front-door.ps1'
        $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$startScript,'-SkipBuild','-Port',[string]$Port,'-BackendConfigPath',$BackendConfigPath,'-ProcessRoutePath',$ProcessRoutePath)
    } else {
        $startScript = Join-Path $Root 'start.ps1'
        $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$startScript,'-SkipBuild','-Port',[string]$Port)
    }
    Start-Process powershell.exe -ArgumentList $arguments -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
    $listener = $null
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Healthy) { $listener = PortOwner; break }
    }
    if ($listener) {
        Set-Content $PidFile ([string]$listener) -Encoding ASCII
        $script:failStreak = 0
        $script:ownedHealthFailures = 0
        Log "started $Role listener PID $listener on 127.0.0.1:$Port"
    } else {
        $script:failStreak++
        Log "$Role child failed to become healthy (consecutive failures: $($script:failStreak))"
    }
}

$mutexName = "Global\CodexLocalMcpKeepAlive-$RoleKey"
$mutex = New-Object System.Threading.Mutex($false,$mutexName)
$held = $false
try {
    try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { exit 0 }
    Log "$Role supervisor started for 127.0.0.1:$Port"
    while ($true) {
        try {
            StartChild
            if ($Role -eq 'FrontDoor' -and -not $TestMode -and (Healthy)) {
                EnsureFunnelConfiguration
                if (-not (PublicHealthy)) { Log 'public front-door health probe failed while local front door is healthy; Funnel configuration left unchanged' }
            }
        } catch { Log "supervisor poll error (continuing): $($_.Exception.Message)" }
        $delay = $PollSeconds
        if ($script:failStreak -gt 0) { $delay = [Math]::Min($BackoffMax, $PollSeconds * [Math]::Pow(2, [Math]::Min(6, $script:failStreak))) }
        Start-Sleep -Seconds $delay
    }
} finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
