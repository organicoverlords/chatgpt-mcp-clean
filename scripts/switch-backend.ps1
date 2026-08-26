param(
    [Parameter(Mandatory=$true)][int]$CandidatePort,
    [string]$CandidateGeneration = '',
    [string]$FrontDoorOrigin = 'http://127.0.0.1:3003',
    [string]$BackendConfigPath = '',
    [int]$HealthSamples = 100,
    [switch]$TestMode
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $BackendConfigPath) { $BackendConfigPath = Join-Path $Root '.state\front-door\active-backend.json' }
if ($CandidatePort -eq 3000) { throw 'Candidate backend must use an alternate loopback port' }
if ($HealthSamples -lt 20 -or $HealthSamples -gt 1000) { throw 'HealthSamples must be between 20 and 1000' }

function Health([string]$Origin) {
    try { return Invoke-RestMethod ($Origin.TrimEnd('/') + '/health') -TimeoutSec 2 } catch { return $null }
}
$candidateOrigin = "http://127.0.0.1:$CandidatePort"
$candidate = $null
for ($attempt=0; $attempt -lt 10; $attempt++) {
    $candidate = Health $candidateOrigin
    if ($candidate -and $candidate.status -eq 'ok' -and $candidate.name -eq 'shell-mcp' -and $candidate.role -eq 'backend' -and [int]$candidate.port -eq $CandidatePort) { break }
    Start-Sleep -Milliseconds 200
}
if (-not $candidate -or $candidate.role -ne 'backend' -or [int]$candidate.port -ne $CandidatePort) { throw "candidate backend on port $CandidatePort is not healthy" }
if (-not $candidate.backend_generation) { throw 'candidate backend did not expose an internal generation identity' }
if ($CandidateGeneration -and $CandidateGeneration -ne [string]$candidate.backend_generation) { throw 'requested candidate generation does not match the running backend generation' }
$CandidateGeneration = [string]$candidate.backend_generation
$frontDoor = Health $FrontDoorOrigin
$frontDoorUri = [uri]$FrontDoorOrigin
$expectedFrontDoorPort = $frontDoorUri.Port
if (-not $TestMode -and $expectedFrontDoorPort -ne 3003) { throw 'live backend switches require the stable front door on port 3003' }
if (-not $frontDoor -or $frontDoor.name -ne 'shell-mcp' -or [int]$frontDoor.port -ne $expectedFrontDoorPort) { throw 'stable front door is not healthy; refusing backend switch' }
$frontDoorProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$frontDoor.pid)"
if (-not $frontDoorProcess -or $frontDoorProcess.CommandLine -notmatch 'dist[\\/]front-door\.js') { throw 'health is not owned by the stable front-door process' }

$old = $null
if (Test-Path $BackendConfigPath) { $old = Get-Content $BackendConfigPath -Raw | ConvertFrom-Json }
if ($old -and [int]$old.port -eq $CandidatePort -and [string]$old.generation -eq $CandidateGeneration) { throw 'candidate is already the active backend generation' }
$next = [ordered]@{ version=1; port=$CandidatePort; generation=$CandidateGeneration }
$directory = Split-Path -Parent $BackendConfigPath
New-Item -ItemType Directory -Force $directory | Out-Null
$temporary = "$BackendConfigPath.$PID.tmp"
$next | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
Move-Item -LiteralPath $temporary -Destination $BackendConfigPath -Force

$failures = 0
$maxLatencyMs = 0.0
for ($sample=0; $sample -lt $HealthSamples; $sample++) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $health = Health $FrontDoorOrigin
    $watch.Stop()
    $maxLatencyMs = [Math]::Max($maxLatencyMs, $watch.Elapsed.TotalMilliseconds)
    if (-not $health -or $health.status -ne 'ok' -or $health.name -ne 'shell-mcp' -or [int]$health.pid -ne [int]$frontDoor.pid) { $failures++ }
    Start-Sleep -Milliseconds 20
}
if ($failures -gt 0) {
    if ($old) {
        $rollback = "$BackendConfigPath.$PID.rollback.tmp"
        $old | ConvertTo-Json | Set-Content -LiteralPath $rollback -Encoding UTF8
        Move-Item -LiteralPath $rollback -Destination $BackendConfigPath -Force
    }
    throw "front-door health failed $failures/$HealthSamples samples; backend config rolled back"
}
$receipt = [ordered]@{
    status='PROVEN'
    switched_at=(Get-Date).ToUniversalTime().ToString('o')
    front_door_pid=[int]$frontDoor.pid
    old_backend_port=if($old){[int]$old.port}else{$null}
    old_backend_generation=if($old){[string]$old.generation}else{$null}
    new_backend_port=$CandidatePort
    new_backend_generation=$CandidateGeneration
    health_samples=$HealthSamples
    health_failures=$failures
    max_health_latency_ms=[Math]::Round($maxLatencyMs,3)
    old_backend_action='DRAIN_ONLY_DO_NOT_STOP_WHILE_PROCESS_ROUTES_EXIST'
}
$receiptPath = Join-Path $directory ("switch-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$receipt | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding UTF8
$receipt | ConvertTo-Json -Compress
