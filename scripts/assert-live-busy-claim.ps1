param(
    [Parameter(Mandatory=$true)][string]$Scope,
    [Parameter(Mandatory=$true)][string]$Actor
)
$ErrorActionPreference = 'Stop'
$busyOwner = Join-Path $env:LOCALAPPDATA 'BusyCoordinator\busy.py'
if (-not (Test-Path -LiteralPath $busyOwner -PathType Leaf)) { throw 'BusyCoordinator owner is unavailable for live production claim verification' }
$output = & python.exe $busyOwner inspect $Scope
if ($LASTEXITCODE -ne 0) { throw "cannot inspect live Busy scope: $Scope" }
try { $inspection = ($output -join "`n") | ConvertFrom-Json } catch { throw "invalid BusyCoordinator inspection for scope: $Scope" }
$claim = $inspection.claim
if (-not $claim -or [string]$claim.scope -ne $Scope) { throw "required live Busy scope is not currently claimed: $Scope" }
if ([string]$claim.actor -ne $Actor) { throw "required live Busy scope is held by another actor: expected=$Actor actual=$($claim.actor)" }
Write-Output ("LIVE_BUSY_CLAIM_OK scope={0} actor={1}" -f $Scope,$Actor)
