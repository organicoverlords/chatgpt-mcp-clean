param(
    [int]$LegacyBackendPort = 3000,
    [int]$StableFrontDoorPort = 3003,
    [int[]]$CandidatePorts = @(3001,3002),
    [string]$LegacySupervisorTask = 'ShellMcpKeepAlive'
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$Tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
$State = Join-Path $Root '.state\front-door'
$Config = Join-Path $State 'active-backend.json'
$Routes = Join-Path $State 'process-routes.json'
New-Item -ItemType Directory -Force $State | Out-Null

function EnvValue([string]$Name) {
    $line = Get-Content -LiteralPath (Join-Path $Root '.env') | Where-Object { $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith('#') } | Select-Object -First 1
    if (-not $line) { return $null }
    return (($line -split '=',2)[1].Trim()).Trim("'").Trim('"')
}
function Health([int]$Port) {
    try { return Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3 } catch { return $null }
}
function PortOwner([int]$Port) {
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { return [int]$listener.OwningProcess }
    return 0
}
function WaitHealth([int]$Port,[string]$Role,[int]$Seconds=30) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        $health = Health $Port
        if ($health -and $health.status -eq 'ok' -and $health.name -eq 'shell-mcp' -and [int]$health.port -eq $Port) {
            if (-not $Role -or $health.role -eq $Role) { return $health }
        }
        Start-Sleep -Milliseconds 200
    } while((Get-Date) -lt $deadline)
    return $null
}
function WriteJsonNoBom([string]$Path,$Value) {
    $json = ($Value | ConvertTo-Json -Depth 8) + [Environment]::NewLine
    [IO.File]::WriteAllText($Path,$json,(New-Object Text.UTF8Encoding($false)))
}

$Origin = EnvValue 'MCP_PUBLIC_ORIGIN'
if (-not $Origin) { throw 'MCP_PUBLIC_ORIGIN is required' }
if (-not (Test-Path $Tailscale)) { throw 'tailscale.exe is unavailable' }
$legacy = Health $LegacyBackendPort
if (-not $legacy -or $legacy.status -ne 'ok' -or $legacy.name -ne 'shell-mcp') { throw 'legacy backend is not healthy' }
$legacyPid = PortOwner $LegacyBackendPort
if (-not $legacyPid -or [int]$legacy.pid -ne $legacyPid) { throw 'legacy health PID does not own port 3000' }
$legacyProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$legacyPid"
if (-not $legacyProcess -or $legacyProcess.CommandLine -notmatch 'dist[\\/]index\.js') { throw 'legacy listener is not the expected Node MCP server' }
if ([int]$legacy.active_requests -ne 0) { throw 'legacy backend has active requests; retry the cutover at an idle boundary' }
if (PortOwner $StableFrontDoorPort) { throw "stable front-door port $StableFrontDoorPort is already occupied" }

$generation = "legacy-$legacyPid"
WriteJsonNoBom $Config ([ordered]@{version=1;port=$LegacyBackendPort;generation=$generation})
if (-not (Test-Path $Routes)) { WriteJsonNoBom $Routes ([ordered]@{version=1;routes=[ordered]@{}}) }

$backendSupervisors = @()
foreach ($candidatePort in $CandidatePorts) {
    if (PortOwner $candidatePort) { throw "candidate backend port $candidatePort is already occupied" }
    $stdout = Join-Path $State "candidate-$candidatePort-supervisor.stdout.log"
    $stderr = Join-Path $State "candidate-$candidatePort-supervisor.stderr.log"
    $backendSupervisors += Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'keepalive.ps1'),'-Role','Backend','-Port',[string]$candidatePort) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    if (-not (WaitHealth $candidatePort 'backend' 30)) { throw "candidate backend $candidatePort did not become healthy" }
}

$frontStdout = Join-Path $State 'front-door.stdout.log'
$frontStderr = Join-Path $State 'front-door.stderr.log'
Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'start-front-door.ps1'),'-SkipBuild','-Port',[string]$StableFrontDoorPort,'-BackendConfigPath',$Config,'-ProcessRoutePath',$Routes) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $frontStdout -RedirectStandardError $frontStderr | Out-Null
$front = WaitHealth $StableFrontDoorPort '' 30
if (-not $front) { throw 'stable front door did not become healthy off the public path' }
$frontPid = [int]$front.pid
$frontProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$frontPid"
if (-not $frontProcess -or $frontProcess.CommandLine -notmatch 'dist[\\/]front-door\.js') { throw 'stable port is not owned by the front-door process' }

$task = Get-ScheduledTask -TaskName $LegacySupervisorTask -ErrorAction Stop
$legacyAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Role Legacy -Port 3000' -f (Join-Path $Root 'keepalive.ps1')) -WorkingDirectory $Root
Set-ScheduledTask -TaskName $LegacySupervisorTask -Action $legacyAction | Out-Null
Stop-ScheduledTask -TaskName $LegacySupervisorTask -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
if ((PortOwner $LegacyBackendPort) -ne $legacyPid -or -not (Health $LegacyBackendPort)) { throw 'stopping the legacy supervisor changed the legacy listener; Funnel was not touched' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$monitorReceipt = Join-Path $State "public-cutover-monitor-$stamp.json"
$monitorStdout = Join-Path $State "public-cutover-monitor-$stamp.stdout.log"
$monitorStderr = Join-Path $State "public-cutover-monitor-$stamp.stderr.log"
$monitor = Start-Process node.exe -ArgumentList @((Join-Path $Root 'scripts\monitor-health.mjs'),'--origin',$Origin,'--output',$monitorReceipt,'--duration','8000') -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $monitorStdout -RedirectStandardError $monitorStderr -PassThru
Start-Sleep -Milliseconds 750
& $Tailscale funnel --yes --bg --https=443 "http://127.0.0.1:$StableFrontDoorPort" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Tailscale Funnel update failed' }
if (-not $monitor.WaitForExit(15000)) { throw 'public continuity monitor did not finish' }
$monitorResult = Get-Content -LiteralPath $monitorReceipt -Raw | ConvertFrom-Json
$public = try { Invoke-RestMethod ($Origin.TrimEnd('/')+'/health') -TimeoutSec 5 } catch { $null }
if ($monitorResult.failure_count -ne 0 -or -not $public -or [int]$public.pid -ne $frontPid) {
    & $Tailscale funnel --yes --bg --https=443 "http://127.0.0.1:$LegacyBackendPort" | Out-Null
    Start-ScheduledTask -TaskName $LegacySupervisorTask -ErrorAction SilentlyContinue
    throw "public cutover continuity failed; Funnel rolled back to legacy backend (monitor failures=$($monitorResult.failure_count))"
}

& (Join-Path $Root 'scripts\install-keepalive-task.ps1') | Out-Null
foreach ($supervisor in $backendSupervisors) { Stop-Process -Id $supervisor.Id -Force -ErrorAction SilentlyContinue }
foreach ($taskName in @('ShellMcpKeepAlive','ShellMcpBackend3001','ShellMcpBackend3002')) { Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

$receipt = [ordered]@{
    status='PROVEN'
    cutover_at=(Get-Date).ToUniversalTime().ToString('o')
    public_origin=$Origin
    legacy_backend_port=$LegacyBackendPort
    legacy_backend_pid=$legacyPid
    stable_front_door_port=$StableFrontDoorPort
    stable_front_door_pid=$frontPid
    active_backend_generation=$generation
    candidate_backend_ports=$CandidatePorts
    public_health_samples=[int]$monitorResult.samples
    public_health_failures=[int]$monitorResult.failure_count
    observed_public_pids=$monitorResult.observed_pids
    observed_public_ports=$monitorResult.observed_ports
    max_public_health_latency_ms=[double]$monitorResult.max_latency_ms
    legacy_listener_recycled=$false
    funnel_tcp_listener_restarted=$false
}
$receiptPath = Join-Path $State "cutover-$stamp.json"
WriteJsonNoBom $receiptPath $receipt
$receipt | ConvertTo-Json -Compress
