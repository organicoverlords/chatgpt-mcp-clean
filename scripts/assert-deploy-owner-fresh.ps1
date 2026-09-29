[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Root,
    [ValidateRange(1,5)][int]$MaxAttempts = 3
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Fail([string]$Message){ throw $Message }

$resolved=[IO.Path]::GetFullPath($Root)
if(-not (Test-Path -LiteralPath $resolved -PathType Container)){ Fail "candidate root missing: $resolved" }
$branch=(& git.exe -C $resolved branch --show-current).Trim()
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)){ Fail 'candidate deploy owner must be on a named branch to refresh upstream' }
$remote=(& git.exe -C $resolved config --get "branch.$branch.remote").Trim()
$mergeRef=(& git.exe -C $resolved config --get "branch.$branch.merge").Trim()
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remote) -or [string]::IsNullOrWhiteSpace($mergeRef)){ Fail "candidate deploy owner branch has no configured upstream: $branch" }

$dirty=@(& git.exe -C $resolved status --porcelain=v1 --untracked-files=normal)
if($LASTEXITCODE -ne 0){ Fail 'cannot inspect candidate deploy owner worktree' }
if($dirty.Count -gt 0){ Fail 'candidate deploy owner worktree must be clean before automatic refresh' }

$initialHead=(& git.exe -C $resolved rev-parse HEAD).Trim().ToLowerInvariant()
if($LASTEXITCODE -ne 0 -or $initialHead -notmatch '^[0-9a-f]{40}$'){ Fail 'cannot resolve candidate deploy owner HEAD' }
$head=$initialHead
$refreshed=$false

for($attempt=1;$attempt -le $MaxAttempts;$attempt++){
    $rows=@(& git.exe -C $resolved ls-remote --heads $remote $mergeRef)
    if($LASTEXITCODE -ne 0){ Fail "candidate deploy owner upstream query failed: remote=$remote branch=$branch" }
    if($rows.Count -ne 1){ Fail "candidate deploy owner upstream is ambiguous or missing: remote=$remote merge_ref=$mergeRef rows=$($rows.Count)" }
    $parts=@(([string]$rows[0]) -split '\s+',2)
    if($parts.Count -ne 2 -or $parts[0] -notmatch '^[0-9a-fA-F]{40}$'){ Fail "candidate deploy owner upstream response is invalid: remote=$remote branch=$branch" }
    $upstreamTip=([string]$parts[0]).ToLowerInvariant()
    if($head -eq $upstreamTip){
        [pscustomobject]@{
            status='FRESH'
            root=$resolved
            branch=$branch
            remote=$remote
            merge_ref=$mergeRef
            initial_head=$initialHead
            head=$head
            upstream_tip=$upstreamTip
            refreshed=$refreshed
            attempts=$attempt
        }
        exit 0
    }

    & git.exe -C $resolved fetch --no-tags $remote $mergeRef
    if($LASTEXITCODE -ne 0){ Fail "candidate deploy owner fetch failed: remote=$remote merge_ref=$mergeRef" }
    $fetched=(& git.exe -C $resolved rev-parse FETCH_HEAD).Trim().ToLowerInvariant()
    if($LASTEXITCODE -ne 0 -or $fetched -ne $upstreamTip){ Fail "candidate deploy owner fetched tip mismatch: expected=$upstreamTip actual=$fetched" }

    & git.exe -C $resolved merge-base --is-ancestor $head $fetched
    if($LASTEXITCODE -ne 0){ Fail "candidate deploy owner cannot auto-refresh non-fast-forward state: branch=$branch local=$head upstream=$fetched" }

    & git.exe -C $resolved merge --ff-only $fetched
    if($LASTEXITCODE -ne 0){ Fail "candidate deploy owner automatic fast-forward failed: branch=$branch local=$head upstream=$fetched" }
    $head=(& git.exe -C $resolved rev-parse HEAD).Trim().ToLowerInvariant()
    if($LASTEXITCODE -ne 0 -or $head -ne $fetched){ Fail "candidate deploy owner automatic fast-forward identity failed: expected=$fetched actual=$head" }
    $refreshed=$true
}
Fail "candidate deploy owner upstream did not converge after $MaxAttempts automatic refresh attempts"
