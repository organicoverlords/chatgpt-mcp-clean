param(
    [string]$RequestPath = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\.state\production-replacement\request.json')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$productionTask = 'McpV3Production3011'
$candidateTask = 'McpV3ProductionReplacementCandidate'
$edgeOwner = Join-Path $env:LOCALAPPDATA 'McpVpsEdge\provision_edge_extras.py'
$busyGuard = Join-Path $PSScriptRoot 'assert-live-busy-claim.ps1'
$publicOrigin = 'https://5-61-91-127.sslip.io'
$publicHost = '5-61-91-127.sslip.io'
$wireGuardHost = '10.203.0.2'
$candidatePort = 3012
$edgeOnCandidate = $false
$productionStopped = $false
$runtimeChanged = $false
$candidateStarted = $false
$candidatePid = 0
$oldHead = ''
$oldBranch = ''
$oldGeneration = ''
$oldDistHash = ''
$backupRoot = ''
$request = $null

function Write-Receipt([string]$Status,[hashtable]$Extra=@{}) {
    if (-not $request) { return }
    $receipt = [ordered]@{
        version = 1
        request_id = [string]$request.request_id
        status = $Status
        recorded_at = (Get-Date).ToUniversalTime().ToString('o')
        candidate_port = $candidatePort
        expected_candidate_commit = [string]$request.expected_candidate_commit
        expected_current_generation = [string]$request.expected_current_generation
        expected_caddy_sha256 = [string]$request.expected_caddy_sha256
        edge_on_candidate = $edgeOnCandidate
        production_task_stopped = $productionStopped
        runtime_changed = $runtimeChanged
        candidate_task_started = $candidateStarted
    }
    foreach ($key in $Extra.Keys) { $receipt[$key] = $Extra[$key] }
    $state = [string]$request.state_root
    New-Item -ItemType Directory -Force -Path $state | Out-Null
    $latest = [string]$request.receipt_path
    $immutable = Join-Path $state ("receipt-{0}.json" -f [string]$request.request_id)
    foreach ($path in @($latest,$immutable)) {
        $tmp = "$path.$PID.tmp"
        $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $path -Force
    }
}

function Get-Health([string]$Uri,[int]$TimeoutSec=3) {
    try { return Invoke-RestMethod -Uri $Uri -TimeoutSec $TimeoutSec } catch { return $null }
}

function Wait-Health([string]$Uri,[scriptblock]$Predicate,[int]$TimeoutSec=30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    do {
        $health = Get-Health $Uri 2
        if ($health -and (& $Predicate $health)) { return $health }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "health verification timed out: $Uri"
}

function Invoke-EdgePort([int]$Port) {
    if ($Port -notin @(3011,3012)) { throw "unsupported edge backend port: $Port" }
    & uv.exe run --with asyncssh python $edgeOwner --caddy-only --backend-port $Port
    if ($LASTEXITCODE -ne 0) { throw "edge owner failed to select WireGuard backend port $Port" }
}

function Get-DirectChildren([int]$ParentPid) {
    return @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentPid" -ErrorAction SilentlyContinue)
}

function Wait-BackendDrain([int]$BackendPid,[int]$TimeoutSec=300) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    do {
        $health = Get-Health 'http://127.0.0.1:3011/health' 2
        if (-not $health -or [int]$health.pid -ne $BackendPid) { throw 'canonical backend changed unexpectedly while drain was in progress' }
        $children = Get-DirectChildren $BackendPid
        $managed = if ($null -ne $health.live_process_count) { [int]$health.live_process_count } else { $children.Count }
        if ([int]$health.active_requests -eq 0 -and $managed -eq 0 -and $children.Count -eq 0) {
            return [ordered]@{active_requests=0;managed_processes=$managed;direct_children=0;drained_at=(Get-Date).ToUniversalTime().ToString('o')}
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    $health = Get-Health 'http://127.0.0.1:3011/health' 2
    $children = Get-DirectChildren $BackendPid
    throw "backend drain timed out: active_requests=$($health.active_requests) direct_children=$($children.Count)"
}

function Wait-CandidateDrain([int]$BackendPid,[int]$TimeoutSec=60) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    do {
        $health = Get-Health "http://${wireGuardHost}:3012/health" 2
        if (-not $health -or [int]$health.pid -ne $BackendPid) { return [ordered]@{drained=$false;reason='candidate_health_changed'} }
        if ([int]$health.active_requests -eq 0 -and [int]$health.live_process_count -eq 0) { return [ordered]@{drained=$true;active_requests=0;live_process_count=0} }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    $health = Get-Health "http://${wireGuardHost}:3012/health" 2
    return [ordered]@{drained=$false;reason='timeout';active_requests=if($health){[int]$health.active_requests}else{$null};live_process_count=if($health){[int]$health.live_process_count}else{$null}}
}

function Wait-PortFree([int]$Port,[int]$TimeoutSec=15) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    do {
        $listener = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.LocalPort -eq $Port } | Select-Object -First 1
        if (-not $listener) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "loopback port did not become free: $Port"
}

function Get-McpStatus([string]$Authority) {
    $result = & curl.exe -sS -o NUL -w '%{http_code}' --max-time 6 -H "Host: $Authority" "$publicOrigin/mcp"
    if ($LASTEXITCODE -ne 0) { throw "public MCP probe failed for Host $Authority" }
    return [int]$result
}

function Stop-TaskIfRunning([string]$TaskName) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
}

function Restore-RuntimeAndCanonical {
    param([string]$RuntimeRoot,[string]$BackupRoot,[string]$OldHead,[string]$OldBranch,[string]$ExpectedDistHash)
    Stop-TaskIfRunning $productionTask
    Wait-PortFree 3011 15
    if ($OldBranch) {
        & git.exe -C $RuntimeRoot switch $OldBranch
    } else {
        & git.exe -C $RuntimeRoot switch --detach $OldHead
    }
    if ($LASTEXITCODE -ne 0) { throw 'failed to restore previous runtime git state' }
    $dist = Join-Path $RuntimeRoot 'dist'
    if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
    Copy-Item -LiteralPath (Join-Path $BackupRoot 'dist') -Destination $dist -Recurse -Force
    $restoredHash = (Get-FileHash -LiteralPath (Join-Path $dist 'index.js') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($restoredHash -ne $ExpectedDistHash) { throw 'restored runtime dist hash does not match the rollback snapshot' }
    Start-ScheduledTask -TaskName $productionTask
    $restored = Wait-Health 'http://127.0.0.1:3011/health' { param($h) $h.status -eq 'ok' -and $h.role -eq 'backend' -and [int]$h.port -eq 3011 } 45
    return $restored
}

try {
    if (-not (Test-Path -LiteralPath $RequestPath -PathType Leaf)) { throw "replacement request not found: $RequestPath" }
    $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json -DateKind String
    if ([int]$request.version -ne 1 -or [int]$request.candidate_port -ne 3012) { throw 'invalid replacement request contract' }
    try {
        $requestedAt = [DateTimeOffset]::ParseExact(
            [string]$request.requested_at,
            'o',
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::None
        ).UtcDateTime
    } catch {
        throw 'replacement request timestamp is not valid invariant ISO-8601 round-trip format'
    }
    if (((Get-Date).ToUniversalTime() - $requestedAt).TotalMinutes -gt 5) { throw 'replacement request is older than 5 minutes' }
    $gatePath = [IO.Path]::GetFullPath([string]$request.gate_receipt_path)
    if (-not (Test-Path -LiteralPath $gatePath -PathType Leaf)) { throw 'authorized production-change-gate receipt disappeared before guardian start' }
    $gateHash = (Get-FileHash -LiteralPath $gatePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($gateHash -ne ([string]$request.gate_receipt_sha256).ToLowerInvariant()) { throw 'production-change-gate receipt changed after request acceptance' }
    $gateItem = Get-Item -LiteralPath $gatePath
    if (((Get-Date).ToUniversalTime() - $gateItem.LastWriteTimeUtc).TotalMinutes -gt 15) { throw 'production-change-gate receipt expired before guardian start' }
    $gate = Get-Content -LiteralPath $gatePath -Raw | ConvertFrom-Json
    $requiredScope = 'mcp_minimal_clone:production-backend-3011'
    if ($gate.verdict -ne 'PASS' -or $gate.target.component -ne 'mcp_minimal_clone' -or $gate.actor -ne [string]$request.gate_actor) { throw 'guardian gate identity mismatch' }
    if (-not $gate.checks.explicit_user_authorization_for_specific_live_change -or -not $gate.checks.independent_rollback_control_route_verified -or -not $gate.checks.offpath_canary_proof_verified) { throw 'guardian gate receipt is missing required proofs' }
    if ($gate.busy_scope -ne $requiredScope -or $gate.checks.busy_scope.claim.scope -ne $requiredScope -or $gate.checks.busy_scope.claim.actor -ne $gate.actor) { throw 'guardian gate receipt lost the exact production backend Busy scope' }
    & $busyGuard -Scope $requiredScope -Actor ([string]$gate.actor) | Out-Null
    $runtimeRoot = [IO.Path]::GetFullPath([string]$request.runtime_root)
    $candidateRoot = [IO.Path]::GetFullPath([string]$request.candidate_root)
    $expectedCommit = ([string]$request.expected_candidate_commit).ToLowerInvariant()
    $candidateDistHash = ([string]$request.candidate_dist_sha256).ToLowerInvariant()
    if (-not (Test-Path -LiteralPath $edgeOwner -PathType Leaf)) { throw 'edge owner is missing' }

    $old = Invoke-RestMethod -Uri 'http://127.0.0.1:3011/health' -TimeoutSec 3
    if ($old.status -ne 'ok' -or $old.role -ne 'backend' -or [string]$old.backend_generation -ne [string]$request.expected_current_generation) { throw 'current backend no longer matches the authorized replacement request' }
    $oldGeneration = [string]$old.backend_generation
    $oldPid = [int]$old.pid

    $runtimeDirty = @(& git.exe -C $runtimeRoot status --porcelain=v1 --untracked-files=no)
    if ($LASTEXITCODE -ne 0 -or $runtimeDirty.Count -gt 0) { throw 'runtime root became dirty after replacement request acceptance' }
    $oldHead = (& git.exe -C $runtimeRoot rev-parse HEAD).Trim().ToLowerInvariant()
    $oldBranch = (& git.exe -C $runtimeRoot symbolic-ref --short -q HEAD).Trim()
    $oldDistHash = (Get-FileHash -LiteralPath (Join-Path $runtimeRoot 'dist\index.js') -Algorithm SHA256).Hash.ToLowerInvariant()
    $backupRoot = Join-Path ([string]$request.state_root) ("rollback-{0}" -f [string]$request.request_id)
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $runtimeRoot 'dist') -Destination (Join-Path $backupRoot 'dist') -Recurse -Force

    Start-ScheduledTask -TaskName $candidateTask
    $candidateStarted = $true
    $candidate = Wait-Health "http://${wireGuardHost}:3012/health" { param($h) $h.status -eq 'ok' -and $h.role -eq 'backend' -and [int]$h.port -eq 3012 -and $h.wireguard_candidate -eq $true } 45
    $candidateGeneration = [string]$candidate.backend_generation
    $candidatePid = [int]$candidate.pid

    $ssh = 'C:\Program Files\Git\usr\bin\ssh.exe'
    $key = Join-Path $HOME '.ssh\tietokettu_edge'
    $remoteCandidate = (& $ssh -o BatchMode=yes -o ConnectTimeout=5 -i $key root@5.61.91.127 'curl -fsS --max-time 5 http://10.203.0.2:3012/health') | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or [string]$remoteCandidate.backend_generation -ne $candidateGeneration) { throw 'VPS cannot reach the exact replacement candidate over WireGuard' }

    & $busyGuard -Scope $requiredScope -Actor ([string]$gate.actor) | Out-Null
    Invoke-EdgePort 3012
    $edgeOnCandidate = $true
    $publicCandidate = Wait-Health "$publicOrigin/health" { param($h) [int]$h.port -eq 3012 -and [string]$h.backend_generation -eq $candidateGeneration -and $h.wireguard_candidate -eq $true } 30
    $candidateBare = Get-McpStatus $publicHost
    $candidate443 = Get-McpStatus "${publicHost}:443"
    $candidate444 = Get-McpStatus "${publicHost}:444"
    if ($candidateBare -ne 401 -or $candidate443 -ne 401 -or $candidate444 -ne 403) { throw "candidate public Host behavior failed: bare=$candidateBare explicit443=$candidate443 nondefault444=$candidate444" }

    $drain = Wait-BackendDrain $oldPid 300

    & $busyGuard -Scope $requiredScope -Actor ([string]$gate.actor) | Out-Null
    Stop-ScheduledTask -TaskName $productionTask
    $productionStopped = $true
    Wait-PortFree 3011 20

    & git.exe -C $runtimeRoot cat-file -e "${expectedCommit}^{commit}"
    if ($LASTEXITCODE -ne 0) { throw 'candidate commit is not present in the production runtime repository' }
    & git.exe -C $runtimeRoot switch --detach $expectedCommit
    if ($LASTEXITCODE -ne 0) { throw 'failed to switch production runtime source to candidate commit' }
    $runtimeChanged = $true
    $runtimeDist = Join-Path $runtimeRoot 'dist'
    if (Test-Path -LiteralPath $runtimeDist) { Remove-Item -LiteralPath $runtimeDist -Recurse -Force }
    Copy-Item -LiteralPath (Join-Path $candidateRoot 'dist') -Destination $runtimeDist -Recurse -Force
    $installedDistHash = (Get-FileHash -LiteralPath (Join-Path $runtimeDist 'index.js') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($installedDistHash -ne $candidateDistHash) { throw 'installed production dist hash differs from the off-path candidate' }
    & node.exe (Join-Path $runtimeRoot 'scripts\verify-process-contract.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'installed production process contract verification failed' }

    Start-ScheduledTask -TaskName $productionTask
    $productionStopped = $false
    $new = Wait-Health 'http://127.0.0.1:3011/health' { param($h) $h.status -eq 'ok' -and $h.role -eq 'backend' -and [int]$h.port -eq 3011 -and $h.wireguard_candidate -eq $false } 45
    $newGeneration = [string]$new.backend_generation
    if ($newGeneration -eq $oldGeneration) { throw 'production task did not create a new backend generation' }

    & $busyGuard -Scope $requiredScope -Actor ([string]$gate.actor) | Out-Null
    Invoke-EdgePort 3011
    $edgeOnCandidate = $false
    $publicCanonical = Wait-Health "$publicOrigin/health" { param($h) [int]$h.port -eq 3011 -and [string]$h.backend_generation -eq $newGeneration -and $h.wireguard_candidate -eq $false } 30
    $bare = Get-McpStatus $publicHost
    $explicit443 = Get-McpStatus "${publicHost}:443"
    $nondefault444 = Get-McpStatus "${publicHost}:444"
    if ($bare -ne 401 -or $explicit443 -ne 401 -or $nondefault444 -ne 403) { throw "canonical public Host behavior failed: bare=$bare explicit443=$explicit443 nondefault444=$nondefault444" }

    $candidateDrain = Wait-CandidateDrain $candidatePid 60
    if ($candidateDrain.drained) {
        Stop-TaskIfRunning $candidateTask
        $candidateStarted = $false
    }
    $successStatus = if($candidateDrain.drained){'SUCCEEDED'}else{'SUCCEEDED_CANDIDATE_DRAIN_PENDING'}
    Write-Receipt $successStatus @{
        old_generation=$oldGeneration
        new_generation=$newGeneration
        old_head=$oldHead
        new_head=$expectedCommit
        old_dist_sha256=$oldDistHash
        new_dist_sha256=$installedDistHash
        candidate_generation=$candidateGeneration
        drain=$drain
        candidate_drain=$candidateDrain
        public_host_bare=$bare
        public_host_explicit_443=$explicit443
        public_host_nondefault_444=$nondefault444
        rollback_root=$backupRoot
    }
    exit 0
} catch {
    $failure = $_.Exception.Message
    $canonicalRecovered = $false
    $recoveryError = $null
    try {
        if ($runtimeChanged -or $productionStopped) {
            $restored = Restore-RuntimeAndCanonical -RuntimeRoot $runtimeRoot -BackupRoot $backupRoot -OldHead $oldHead -OldBranch $oldBranch -ExpectedDistHash $oldDistHash
            $productionStopped = $false
            $runtimeChanged = $false
            $canonicalRecovered = $true
        } else {
            $healthy = Get-Health 'http://127.0.0.1:3011/health' 3
            $canonicalRecovered = $healthy -and $healthy.status -eq 'ok' -and $healthy.role -eq 'backend'
        }
    } catch {
        $recoveryError = $_.Exception.Message
    }

    if ($edgeOnCandidate -and $canonicalRecovered) {
        try {
            Invoke-EdgePort 3011
            $edgeOnCandidate = $false
            Wait-Health "$publicOrigin/health" { param($h) [int]$h.port -eq 3011 -and $h.wireguard_candidate -eq $false } 30 | Out-Null
            $candidateDrain = if($candidatePid){Wait-CandidateDrain $candidatePid 60}else{[ordered]@{drained=$true;reason='candidate_not_started'}}
            if ($candidateDrain.drained) { Stop-TaskIfRunning $candidateTask; $candidateStarted = $false }
            $rollbackReceipt = if($candidateDrain.drained){'ROLLED_BACK'}else{'ROLLED_BACK_CANDIDATE_DRAIN_PENDING'}
            Write-Receipt $rollbackReceipt @{error=$failure;recovery_error=$recoveryError;old_head=$oldHead;old_dist_sha256=$oldDistHash;rollback_root=$backupRoot;candidate_drain=$candidateDrain}
            exit 1
        } catch {
            $recoveryError = "${recoveryError}; edge_restore=$($_.Exception.Message)"
        }
    }

    if ($edgeOnCandidate -and $candidateStarted) {
        $candidateHealth = Get-Health "http://${wireGuardHost}:3012/health" 3
        if ($candidateHealth -and $candidateHealth.status -eq 'ok') {
            Write-Receipt 'DEGRADED_CANDIDATE_SERVING' @{error=$failure;recovery_error=$recoveryError;old_head=$oldHead;old_dist_sha256=$oldDistHash;rollback_root=$backupRoot;candidate_generation=[string]$candidateHealth.backend_generation}
            exit 2
        }
    }

    $candidateDrain = if($candidateStarted -and $candidatePid){Wait-CandidateDrain $candidatePid 30}else{[ordered]@{drained=$true;reason='candidate_not_started'}}
    if ($candidateStarted -and $candidateDrain.drained) { Stop-TaskIfRunning $candidateTask; $candidateStarted = $false }
    Write-Receipt 'FAILED_PRE_CUTOVER' @{error=$failure;recovery_error=$recoveryError;old_head=$oldHead;old_dist_sha256=$oldDistHash;rollback_root=$backupRoot;candidate_drain=$candidateDrain}
    exit 3
}
