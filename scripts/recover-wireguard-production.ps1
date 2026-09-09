param(
 [Parameter(Mandatory=$true)][string]$GateReceiptPath,
 [Parameter(Mandatory=$true)][string]$ExpectedRequestId,
 [Parameter(Mandatory=$true)][string]$ExpectedCanonicalGeneration,
 [Parameter(Mandatory=$true)][string]$ExpectedCandidateGeneration
)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$repo=Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean'
$state=Join-Path $repo '.state\production-replacement'
$requestPath=Join-Path $state 'request.json'; $receiptPath=Join-Path $state 'receipt.json'
$busyGuard=Join-Path $repo 'scripts\assert-live-busy-claim.ps1'
$edgeOwner=Join-Path $env:LOCALAPPDATA 'McpVpsEdge\provision_edge_extras.py'
$scope='mcp_minimal_clone:production-backend-3011'
$prodTask='McpV3Production3011'; $candidateTask='McpV3ProductionReplacementCandidate'
$publicOrigin='https://5-61-91-127.sslip.io'

function Health([string]$u,[int]$t=3){try{Invoke-RestMethod -Uri $u -TimeoutSec $t}catch{$null}}
function WaitHealth([string]$u,[scriptblock]$pred,[int]$sec=30){
 $deadline=[DateTime]::UtcNow.AddSeconds($sec)
 do{$h=Health $u 2;if($h -and (& $pred $h)){return $h};Start-Sleep -Milliseconds 200}while([DateTime]::UtcNow -lt $deadline)
 throw "health verification timed out: $u"
}
function WriteRecovery([object]$canonical,[object]$candidate,[object]$previous){
 $r=[ordered]@{version=1;request_id=$ExpectedRequestId;status='RECOVERED_CANONICAL';recorded_at=(Get-Date).ToUniversalTime().ToString('o');previous_status=[string]$previous.status;edge_on_candidate=$false;production_task_stopped=$false;candidate_task_started=$false;canonical_generation=[string]$canonical.backend_generation;candidate_generation=[string]$candidate.backend_generation;canonical_port=3011;recovered_from_port=3012}
 $stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ');$immutable=Join-Path $state ("recovery-{0}-{1}.json" -f $ExpectedRequestId,$stamp)
 foreach($path in @($receiptPath,$immutable)){$tmp="$path.$PID.tmp";$r|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $tmp -Encoding UTF8;Move-Item $tmp $path -Force}
 return $immutable
}

if(!(Test-Path $GateReceiptPath -PathType Leaf)){throw 'fresh production-change-gate receipt is required'}
$gi=Get-Item $GateReceiptPath;if(((Get-Date).ToUniversalTime()-$gi.LastWriteTimeUtc).TotalMinutes -gt 15){throw 'production-change-gate receipt is older than 15 minutes'}
$g=Get-Content $GateReceiptPath -Raw|ConvertFrom-Json
if($g.verdict-ne'PASS' -or $g.target.component-ne'vps_edge_ingress'){throw 'production-change-gate receipt does not PASS for vps_edge_ingress'}
if(!$g.checks.independent_rollback_control_route_verified -or !$g.checks.offpath_canary_proof_verified){throw 'production-change-gate receipt is missing rollback/off-path proof'}
if(!$g.checks.explicit_user_authorization_for_specific_live_change -and !$g.checks.routine_scoped_reversible_advance){throw 'production-change-gate receipt lacks live-change authorization'}
if($g.busy_scope-ne$scope -or $g.checks.busy_scope.claim.scope-ne$scope -or !$g.actor -or $g.checks.busy_scope.claim.actor-ne$g.actor){throw 'production-change-gate receipt does not hold exact production Busy scope'}
& $busyGuard -Scope $scope -Actor ([string]$g.actor)|Out-Null

$request=Get-Content $requestPath -Raw|ConvertFrom-Json -DateKind String
$previous=Get-Content $receiptPath -Raw|ConvertFrom-Json -DateKind String
if([string]$request.request_id-ne$ExpectedRequestId -or [string]$previous.request_id-ne$ExpectedRequestId){throw 'replacement request identity changed before recovery'}
if([string]$previous.status-ne'DEGRADED_CANDIDATE_SERVING' -or $previous.edge_on_candidate-ne$true){throw 'recovery requires DEGRADED_CANDIDATE_SERVING with edge_on_candidate=true'}
if([string]$previous.candidate_generation-ne$ExpectedCandidateGeneration){throw 'degraded receipt candidate generation mismatch'}
$pt=Get-ScheduledTask $prodTask -ErrorAction SilentlyContinue;$ct=Get-ScheduledTask $candidateTask -ErrorAction SilentlyContinue
if(!$pt -or $pt.State-ne'Running'){throw 'canonical production task must be running'}
if(!$ct -or $ct.State-ne'Running'){throw 'replacement candidate task must be running'}

$canonical=Health 'http://127.0.0.1:3011/health';$candidate=Health 'http://10.203.0.2:3012/health';$public=Health "$publicOrigin/health" 5
if(!$canonical -or [int]$canonical.port-ne3011 -or [string]$canonical.backend_generation-ne$ExpectedCanonicalGeneration -or $canonical.wireguard_candidate-ne$false){throw 'canonical 3011 does not match expected recovery target'}
if(!$candidate -or [int]$candidate.port-ne3012 -or [string]$candidate.backend_generation-ne$ExpectedCandidateGeneration -or $candidate.wireguard_candidate-ne$true){throw 'candidate 3012 does not match degraded receipt'}
if(!$public -or [int]$public.port-ne3012 -or [string]$public.backend_generation-ne$ExpectedCandidateGeneration){throw 'public edge is no longer serving expected candidate'}

& $busyGuard -Scope $scope -Actor ([string]$g.actor)|Out-Null
& uv.exe run --with asyncssh python $edgeOwner --caddy-only --backend-port 3011
if($LASTEXITCODE-ne0){throw 'edge owner failed to restore canonical WireGuard 3011'}
$publicCanonical=WaitHealth "$publicOrigin/health" {param($h)[int]$h.port-eq3011 -and [string]$h.backend_generation-eq$ExpectedCanonicalGeneration -and $h.wireguard_candidate-eq$false} 30

$deadline=[DateTime]::UtcNow.AddSeconds(30)
do{$h=Health 'http://10.203.0.2:3012/health';if(!$h -or ([int]$h.active_requests-eq0 -and [int]$h.live_process_count-eq0)){break};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow-lt$deadline)
if($h -and ([int]$h.active_requests-ne0 -or [int]$h.live_process_count-ne0)){throw 'candidate did not become idle after edge restore'}
& $busyGuard -Scope $scope -Actor ([string]$g.actor)|Out-Null
Stop-ScheduledTask -TaskName $candidateTask
$deadline=[DateTime]::UtcNow.AddSeconds(20)
do{$ct=Get-ScheduledTask $candidateTask -ErrorAction SilentlyContinue;$listener=Get-NetTCPConnection -State Listen -LocalPort 3012 -ErrorAction SilentlyContinue|Select-Object -First 1;if($ct -and $ct.State-ne'Running' -and !$listener){break};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow-lt$deadline)
if($listener){throw 'candidate listener did not stop'}
$final=WaitHealth "$publicOrigin/health" {param($h)[int]$h.port-eq3011 -and [string]$h.backend_generation-eq$ExpectedCanonicalGeneration} 15
$rr=WriteRecovery $final $candidate $previous
[ordered]@{status='RECOVERED_CANONICAL';request_id=$ExpectedRequestId;canonical_generation=$ExpectedCanonicalGeneration;candidate_generation=$ExpectedCandidateGeneration;recovery_receipt=$rr}|ConvertTo-Json -Compress
