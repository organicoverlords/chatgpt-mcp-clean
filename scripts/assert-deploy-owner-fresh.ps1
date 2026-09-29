[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Root
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Fail([string]$Message){ throw $Message }

$resolved=[IO.Path]::GetFullPath($Root)
if(-not (Test-Path -LiteralPath $resolved -PathType Container)){ Fail "candidate root missing: $resolved" }
$head=(& git.exe -C $resolved rev-parse HEAD).Trim().ToLowerInvariant()
if($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$'){ Fail 'cannot resolve candidate deploy owner HEAD' }
$branch=(& git.exe -C $resolved branch --show-current).Trim()
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)){ Fail 'candidate deploy owner must be on a named branch to prove upstream freshness' }
$remote=(& git.exe -C $resolved config --get "branch.$branch.remote").Trim()
$mergeRef=(& git.exe -C $resolved config --get "branch.$branch.merge").Trim()
if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remote) -or [string]::IsNullOrWhiteSpace($mergeRef)){ Fail "candidate deploy owner branch has no configured upstream: $branch" }
$rows=@(& git.exe -C $resolved ls-remote --heads $remote $mergeRef)
if($LASTEXITCODE -ne 0){ Fail "candidate deploy owner upstream query failed: remote=$remote branch=$branch" }
if($rows.Count -ne 1){ Fail "candidate deploy owner upstream is ambiguous or missing: remote=$remote merge_ref=$mergeRef rows=$($rows.Count)" }
$parts=@(([string]$rows[0]) -split '\s+',2)
if($parts.Count -ne 2 -or $parts[0] -notmatch '^[0-9a-fA-F]{40}$'){ Fail "candidate deploy owner upstream response is invalid: remote=$remote branch=$branch" }
$upstreamTip=([string]$parts[0]).ToLowerInvariant()
if($head -ne $upstreamTip){ Fail "candidate deploy owner stale: branch=$branch local=$head upstream=$upstreamTip remote=$remote" }
[pscustomobject]@{
    status='FRESH'
    root=$resolved
    branch=$branch
    remote=$remote
    merge_ref=$mergeRef
    head=$head
    upstream_tip=$upstreamTip
}
