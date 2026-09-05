param(
    [Parameter(Mandatory=$true)][string]$CandidateRoot,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedCandidateCommit,
    [Parameter(Mandatory=$true)][string]$ExpectedCurrentGeneration,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedCaddySha256,
    [Parameter(Mandatory=$true)][string]$GateReceiptPath,
    [switch]$ExplicitUserAuthorization,
    [switch]$IndependentRollbackVerified,
    [switch]$OffPathProofVerified
)
$ErrorActionPreference = 'Stop'
if (-not $ExplicitUserAuthorization -or -not $IndependentRollbackVerified -or -not $OffPathProofVerified) {
    throw 'production replacement requires explicit user authorization, independent rollback verification, and off-path proof verification'
}
if (-not (Test-Path -LiteralPath $GateReceiptPath -PathType Leaf)) { throw 'fresh production-change-gate receipt is required' }
$gateItem = Get-Item -LiteralPath $GateReceiptPath
if (((Get-Date).ToUniversalTime() - $gateItem.LastWriteTimeUtc).TotalMinutes -gt 15) { throw 'production-change-gate receipt is older than 15 minutes' }
$gateReceiptPath = [IO.Path]::GetFullPath($GateReceiptPath)
$gateReceiptSha256 = (Get-FileHash -LiteralPath $gateReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
$gate = Get-Content -LiteralPath $gateReceiptPath -Raw | ConvertFrom-Json
$requiredScope = 'mcp_minimal_clone:production-backend-3011'
if ($gate.verdict -ne 'PASS' -or $gate.target.component -ne 'mcp_minimal_clone') { throw 'production-change-gate receipt does not PASS for mcp_minimal_clone' }
if (-not $gate.checks.explicit_user_authorization_for_specific_live_change -or -not $gate.checks.independent_rollback_control_route_verified -or -not $gate.checks.offpath_canary_proof_verified) { throw 'production-change-gate receipt is missing required proofs' }
if ($gate.busy_scope -ne $requiredScope -or $gate.checks.busy_scope.claim.scope -ne $requiredScope -or -not $gate.actor -or $gate.checks.busy_scope.claim.actor -ne $gate.actor) { throw 'production-change-gate receipt does not hold the exact production backend Busy scope' }
$repo = Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean'
$busyGuard = Join-Path $repo 'scripts\assert-live-busy-claim.ps1'
if (-not (Test-Path -LiteralPath $busyGuard -PathType Leaf)) { throw 'live Busy verification helper is missing' }
& $busyGuard -Scope $requiredScope -Actor ([string]$gate.actor) | Out-Null
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'ChatGPTMcpMinimal'
$edgeOwner = Join-Path $env:LOCALAPPDATA 'McpVpsEdge\provision_edge_extras.py'
$state = Join-Path $repo '.state\production-replacement'
$requestPath = Join-Path $state 'request.json'
$receiptPath = Join-Path $state 'receipt.json'
$freezePath = 'C:\Users\Lauri\Desktop\vault\04 Operating Contracts\mcp-known-good-freeze.json'
$guardianTask = 'McpV3ProductionReplacementGuardian'
$candidateTask = 'McpV3ProductionReplacementCandidate'
foreach ($taskName in @($guardianTask,$candidateTask)) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) { throw "required replacement task is not installed: $taskName" }
    if ($task.State -eq 'Running') { throw "replacement task is already running: $taskName" }
}
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:3011/health' -TimeoutSec 3
if ($health.status -ne 'ok' -or $health.role -ne 'backend' -or [string]$health.backend_generation -ne $ExpectedCurrentGeneration) {
    throw "current backend generation mismatch: expected=$ExpectedCurrentGeneration actual=$($health.backend_generation)"
}
$root = [IO.Path]::GetFullPath($CandidateRoot)
$head = (& git.exe -C $root rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $head -ne $ExpectedCandidateCommit.ToLowerInvariant()) { throw 'candidate root does not match expected commit' }
$dirty = @(& git.exe -C $root status --porcelain=v1 --untracked-files=no)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) { throw 'candidate root must have no tracked modifications' }
& node.exe (Join-Path $root 'scripts\verify-process-contract.mjs')
if ($LASTEXITCODE -ne 0) { throw 'candidate process contract verification failed' }
$candidateDist = Join-Path $root 'dist\index.js'
if (-not (Test-Path -LiteralPath $candidateDist -PathType Leaf)) { throw 'candidate dist/index.js is missing' }
$listener = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 3012 } | Select-Object -First 1
if ($listener) { throw "candidate port 3012 is already listening at $($listener.LocalAddress)" }
if (-not (Test-Path -LiteralPath $edgeOwner -PathType Leaf)) { throw 'McpVpsEdge provisioner is missing' }
$render = & uv.exe run --with asyncssh python $edgeOwner --render-caddy --backend-port 3012
if ($LASTEXITCODE -ne 0 -or ($render -join "`n") -notmatch 'reverse_proxy 10\.203\.0\.2:3012') { throw 'edge owner cannot render the temporary WireGuard candidate route' }
if (-not (Test-Path -LiteralPath $freezePath -PathType Leaf)) { throw 'canonical MCP freeze is missing' }
$freeze = Get-Content -LiteralPath $freezePath -Raw | ConvertFrom-Json
if ([string]$freeze.status -notin @('CANDIDATE_KNOWN_GOOD','PROVEN_KNOWN_GOOD')) { throw 'canonical MCP freeze is not usable as a replacement boundary' }
if (([string]$freeze.production_identity.caddy.sha256).ToLowerInvariant() -ne $ExpectedCaddySha256.ToLowerInvariant()) { throw 'expected Caddy hash does not match the canonical freeze; refresh live preflight before replacement' }
$runtimeDirty = @(& git.exe -C $runtimeRoot status --porcelain=v1 --untracked-files=no)
if ($LASTEXITCODE -ne 0 -or $runtimeDirty.Count -gt 0) { throw 'production runtime root has tracked modifications; replacement refused' }
New-Item -ItemType Directory -Force -Path $state | Out-Null
$requestId = [guid]::NewGuid().ToString()
$payload = [ordered]@{
    version = 1
    request_id = $requestId
    requested_at = (Get-Date).ToUniversalTime().ToString('o')
    candidate_root = $root
    candidate_port = 3012
    expected_candidate_commit = $ExpectedCandidateCommit.ToLowerInvariant()
    expected_current_generation = $ExpectedCurrentGeneration
    expected_caddy_sha256 = $ExpectedCaddySha256.ToLowerInvariant()
    gate_receipt_path = $gateReceiptPath
    gate_receipt_sha256 = $gateReceiptSha256
    gate_actor = [string]$gate.actor
    candidate_dist_sha256 = (Get-FileHash -LiteralPath $candidateDist -Algorithm SHA256).Hash.ToLowerInvariant()
    runtime_root = $runtimeRoot
    state_root = $state
    receipt_path = $receiptPath
}
$tmp = "$requestPath.$PID.tmp"
$payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tmp -Encoding UTF8
Move-Item -LiteralPath $tmp -Destination $requestPath -Force
Start-ScheduledTask -TaskName $guardianTask
[ordered]@{status='ACCEPTED';request_id=$requestId;request_path=$requestPath;receipt_path=$receiptPath;candidate_port=3012} | ConvertTo-Json -Compress
