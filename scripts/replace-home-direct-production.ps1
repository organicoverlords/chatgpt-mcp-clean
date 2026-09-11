[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$CandidatePort,
    [Parameter(Mandatory=$true)][string]$CandidateGeneration,
    [Parameter(Mandatory=$true)][string]$Actor,
    [Parameter(Mandatory=$true)][string]$BusyScope,
    [ValidateRange(1024,65535)][int]$ExpectedCurrentPort = 3036,
    [ValidateRange(1024,65535)][int]$IndependentRollbackPort = 3022,
    [string]$StableHost = '91-159-12-133.sslip.io',
    [string]$PublicOrigin = 'https://91-159-12-133.sslip.io',
    [string]$CaddyConfigPath = (Join-Path $env:LOCALAPPDATA 'Caddy\mcp-home-test\Caddyfile'),
    [string]$CaddyExe = (Join-Path $env:LOCALAPPDATA 'Caddy\mcp-home-test\caddy.exe'),
    [string]$StackAtlasPath = 'C:\Users\Lauri\Desktop\vault\tools\stack_atlas.py'
)
$ErrorActionPreference='Stop'
function Health([int]$Port){ Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 3 }
function Load-Caddy([string]$Config){
    & $CaddyExe validate --config $Config --adapter caddyfile | Out-Null
    if($LASTEXITCODE -ne 0){ throw "Caddy validation failed: $Config" }
    $json=Join-Path $env:TEMP ("mcp-home-direct-caddy-{0}.json" -f [guid]::NewGuid().ToString('N'))
    try {
        & $CaddyExe adapt --config $Config --adapter caddyfile --pretty > $json
        if($LASTEXITCODE -ne 0){ throw 'Caddy adaptation failed' }
        Invoke-WebRequest -Uri 'http://127.0.0.1:2019/load' -Method Post -ContentType 'application/json' -Body (Get-Content -Raw $json) -TimeoutSec 5 | Out-Null
    } finally { Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue }
}
if($CandidatePort -eq $ExpectedCurrentPort){ throw 'candidate must use an alternate port' }
if(-not (Test-Path -LiteralPath $CaddyConfigPath -PathType Leaf)){ throw "Caddy config missing: $CaddyConfigPath" }
if(-not (Test-Path -LiteralPath $CaddyExe -PathType Leaf)){ throw "Caddy executable missing: $CaddyExe" }
$current=Health $ExpectedCurrentPort
$candidate=Health $CandidatePort
$rollback=Health $IndependentRollbackPort
if($current.status -ne 'ok' -or [int]$current.port -ne $ExpectedCurrentPort){ throw 'current backend health proof failed' }
if($candidate.status -ne 'ok' -or [int]$candidate.port -ne $CandidatePort -or [string]$candidate.backend_generation -ne $CandidateGeneration){ throw 'candidate health/generation proof failed' }
if($rollback.status -ne 'ok' -or [int]$rollback.port -ne $IndependentRollbackPort){ throw 'independent rollback health proof failed' }
$gateText = & python $StackAtlasPath production-change-gate mcp --actor $Actor --busy-scope $BusyScope --explicit-user-authorization --independent-rollback-verified --offpath-proof-verified
if($LASTEXITCODE -ne 0){ throw 'production change gate execution failed' }
$gate=$gateText | ConvertFrom-Json
if($gate.verdict -ne 'PASS'){ throw ("production change gate blocked: " + (($gate.reasons) -join ',')) }
$original=[IO.File]::ReadAllText($CaddyConfigPath)
$needle="127.0.0.1:$ExpectedCurrentPort"
$replacement="127.0.0.1:$CandidatePort"
$count=([regex]::Matches($original,[regex]::Escape($needle))).Count
if($count -ne 2){ throw "expected exactly two stable upstream references to $needle; found $count" }
$candidateText=$original.Replace($needle,$replacement)
$temp=Join-Path (Split-Path -Parent $CaddyConfigPath) ("Caddyfile.issue274-{0}.tmp" -f [guid]::NewGuid().ToString('N'))
$backup="$CaddyConfigPath.pre-home-direct-replace-$(Get-Date -Format yyyyMMddHHmmss)"
[IO.File]::WriteAllText($temp,$candidateText,(New-Object Text.UTF8Encoding($false)))
try {
    Load-Caddy $temp
    Start-Sleep -Milliseconds 300
    $localText=& curl.exe -ksS --max-time 4 --resolve ("{0}:8443:127.0.0.1" -f $StableHost) ("https://{0}:8443/health" -f $StableHost)
    if($LASTEXITCODE -ne 0){ throw 'local HTTPS route probe failed' }
    $local=$localText | ConvertFrom-Json
    if([int]$local.port -ne $CandidatePort -or [string]$local.backend_generation -ne $CandidateGeneration){ throw 'local HTTPS route did not reach candidate' }
    $public=Invoke-RestMethod -Uri ($PublicOrigin.TrimEnd('/') + '/health') -TimeoutSec 6
    if([int]$public.port -ne $CandidatePort -or [string]$public.backend_generation -ne $CandidateGeneration){ throw 'public route did not reach candidate' }
    Copy-Item -LiteralPath $CaddyConfigPath -Destination $backup
    Move-Item -LiteralPath $temp -Destination $CaddyConfigPath -Force
    [pscustomobject]@{status='PASS';candidate_port=$CandidatePort;candidate_generation=$CandidateGeneration;old_port=$ExpectedCurrentPort;rollback_port=$IndependentRollbackPort;public_port=[int]$public.port;public_generation=[string]$public.backend_generation;caddy_backup=$backup;old_backend_action='PRESERVE_FOR_ROLLBACK'} | ConvertTo-Json -Compress
} catch {
    try {
        $rollbackConfig=Join-Path $env:TEMP ("mcp-home-direct-rollback-{0}.Caddyfile" -f [guid]::NewGuid().ToString('N'))
        [IO.File]::WriteAllText($rollbackConfig,$original,(New-Object Text.UTF8Encoding($false)))
        try { Load-Caddy $rollbackConfig } finally { Remove-Item -LiteralPath $rollbackConfig -Force -ErrorAction SilentlyContinue }
    } catch { }
    throw
} finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
