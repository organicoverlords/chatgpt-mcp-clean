param(
    [string]$RequestPath = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\.state\production-replacement\request.json')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $RequestPath -PathType Leaf)) { throw "replacement request not found: $RequestPath" }
$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
if ([int]$request.version -ne 1) { throw 'unsupported replacement request version' }
if ([int]$request.candidate_port -ne 3012) { throw 'replacement candidate task only permits WireGuard port 3012' }
$root = [IO.Path]::GetFullPath([string]$request.candidate_root)
$expected = ([string]$request.expected_candidate_commit).Trim().ToLowerInvariant()
if ($expected -notmatch '^[0-9a-f]{40}$') { throw 'expected candidate commit must be a full SHA-1' }
$head = (& git.exe -C $root rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $head -ne $expected) { throw "candidate root HEAD mismatch: expected=$expected actual=$head" }
$dirty = @(& git.exe -C $root status --porcelain=v1 --untracked-files=no)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) { throw 'candidate root must have no tracked modifications' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\index.js') -PathType Leaf)) { throw 'candidate build is missing dist/index.js' }
$repo = Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean'
$envFile = Join-Path $repo '.env'
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        $s = $line.Trim()
        if (-not $s -or $s.StartsWith('#') -or $s -notmatch '=') { continue }
        $name, $value = $s -split '=', 2
        Set-Item -Path "Env:$($name.Trim())" -Value $value.Trim().Trim("'").Trim('"')
    }
}
$short = ([string]$request.request_id).Replace('-','').Substring(0,12)
& (Join-Path $root 'scripts\start-minimal-clone.ps1') `
    -InstanceId "replacement-$short" `
    -Port 3012 `
    -PublicOrigin 'https://5-61-91-127.sslip.io' `
    -StateRoot (Join-Path $repo 'minimal-connectors') `
    -OAuthStorePath (Join-Path $repo 'minimal-connectors\clone-a\oauth.json') `
    -SharedReceiptDirectory (Join-Path $repo 'minimal-connectors\shared-process-receipts') `
    -WireGuardCandidate `
    -SkipBuild
exit $LASTEXITCODE
