param(
    [Parameter(Mandatory=$true)][string]$GateReceiptPath,
    [Parameter(Mandatory=$true)][string]$ObserverSourcePath,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ExpectedRemoteSha256
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$busyGuard = Join-Path $PSScriptRoot 'assert-live-busy-claim.ps1'
$requiredScope = 'vps_edge_ingress:observer'
$ssh = 'C:\Program Files\Git\usr\bin\ssh.exe'
$scp = 'C:\Program Files\Git\usr\bin\scp.exe'
$key = Join-Path $HOME '.ssh\tietokettu_edge'
$target = 'root@5.61.91.127'
$remotePath = '/usr/local/bin/mcp-edge-health'

foreach ($path in @($GateReceiptPath,$ObserverSourcePath,$busyGuard,$ssh,$scp,$key)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "required file missing: $path" }
}

$gateItem = Get-Item -LiteralPath $GateReceiptPath
if (((Get-Date).ToUniversalTime() - $gateItem.LastWriteTimeUtc).TotalMinutes -gt 15) {
    throw 'production-change-gate receipt is older than 15 minutes'
}
$gate = Get-Content -LiteralPath $GateReceiptPath -Raw | ConvertFrom-Json
if ($gate.verdict -ne 'PASS' -or $gate.target.component -ne 'vps_edge_ingress') {
    throw 'production-change-gate receipt does not PASS for vps_edge_ingress'
}
if ($gate.busy_scope -ne $requiredScope -or
    $gate.checks.busy_scope.claim.scope -ne $requiredScope -or
    -not $gate.actor -or
    $gate.checks.busy_scope.claim.actor -ne $gate.actor) {
    throw 'production-change-gate receipt does not hold exact VPS observer Busy scope'
}
if (-not $gate.checks.independent_rollback_control_route_verified -or
    -not $gate.checks.offpath_canary_proof_verified) {
    throw 'production-change-gate receipt is missing rollback/off-path proof'
}
if (-not $gate.checks.routine_scoped_reversible_advance -and
    -not $gate.checks.explicit_user_authorization_for_specific_live_change) {
    throw 'production-change-gate receipt lacks live-change authorization'
}

& $busyGuard -Scope $requiredScope -Actor ([string]$gate.actor) | Out-Null

$expected = $ExpectedRemoteSha256.ToLowerInvariant()
$remoteHashLine = & $ssh -T -o BatchMode=yes -o ConnectTimeout=5 -i $key $target "sha256sum $remotePath"
if ($LASTEXITCODE -ne 0 -or -not $remoteHashLine) { throw 'cannot read current VPS observer hash' }
$remoteHash = ([string]$remoteHashLine).Split(' ',[System.StringSplitOptions]::RemoveEmptyEntries)[0].ToLowerInvariant()
if ($remoteHash -ne $expected) {
    throw "VPS observer drifted before install: expected=$expected actual=$remoteHash"
}

$id = [guid]::NewGuid().ToString('N')
$stage = "/tmp/mcp-edge-health-$id"
$backup = "/var/lib/mcp-edge/backups/mcp-edge-health-$expected"
$stageTarget = $target + ':' + $stage
$normalizedObserver = Join-Path $env:TEMP ("mcp-edge-health-$id.sh")

try {
    $observerText = [Text.RegularExpressions.Regex]::Replace([IO.File]::ReadAllText($ObserverSourcePath), '\r\n?', [string][char]10)
    [IO.File]::WriteAllText($normalizedObserver,$observerText,[Text.UTF8Encoding]::new($false))

    & $scp -q -o BatchMode=yes -o ConnectTimeout=5 -i $key $normalizedObserver $stageTarget
    if ($LASTEXITCODE -ne 0) { throw 'observer staging copy failed' }

    $remoteTemplate = @'
set -eu
remote='__REMOTE__'
stage='__STAGE__'
backup='__BACKUP__'
expected='__EXPECTED__'
current=$(sha256sum "$remote" | awk '{print $1}')
test "$current" = "$expected"
install -d -o root -g root -m 0755 /var/lib/mcp-edge/backups
if [ ! -f "$backup" ]; then cp -a "$remote" "$backup"; fi
rollback() {
  cp -a "$backup" "$remote" || true
  chmod 0755 "$remote" || true
  systemctl start mcp-edge-health.service >/dev/null 2>&1 || true
  rm -f "$stage" || true
}
trap rollback ERR
bash -n "$stage"
install -o root -g root -m 0755 "$stage" "$remote"
rm -f "$stage"
systemctl start mcp-edge-health.service
grep -q '"machine_probes"' /var/lib/mcp-edge/status.json
trap - ERR
cat /var/lib/mcp-edge/status.json
printf '\nbackup=%s\n' "$backup"
'@

    $remote = $remoteTemplate.Replace('__REMOTE__',$remotePath).
        Replace('__STAGE__',$stage).
        Replace('__BACKUP__',$backup).
        Replace('__EXPECTED__',$expected)
    $remote = [Text.RegularExpressions.Regex]::Replace($remote, '\r\n?', [string][char]10)

    $result = & $ssh -T -o BatchMode=yes -o ConnectTimeout=5 -i $key $target $remote
    if ($LASTEXITCODE -ne 0) { throw 'VPS observer install or live validation failed; rollback attempted remotely' }

    $result
} finally {
    Remove-Item -LiteralPath $normalizedObserver -Force -ErrorAction SilentlyContinue
}
