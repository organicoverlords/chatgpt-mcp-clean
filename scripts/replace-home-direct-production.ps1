[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$CandidatePort,
    [Parameter(Mandatory=$true)][string]$CandidateGeneration,
    [Parameter(Mandatory=$true)][string]$Actor,
    [Parameter(Mandatory=$true)][string]$BusyScope,
    [Nullable[int]]$ExpectedCurrentPort = $null,
    [ValidateRange(1024,65535)][int]$IndependentRollbackPort = 3022,
    [string]$StableHost = '91-159-12-133.sslip.io',
    [string]$PublicOrigin = 'https://91-159-12-133.sslip.io',
    [string]$CaddyConfigPath = (Join-Path $env:LOCALAPPDATA 'Caddy\mcp-home-test\Caddyfile'),
    [string]$CaddyExe = (Join-Path $env:LOCALAPPDATA 'Caddy\mcp-home-test\caddy.exe'),
    [string]$StackAtlasPath = 'C:\Users\Lauri\Desktop\vault\tools\stack_atlas.py',
    [string]$CurrentTopologyPath = 'C:\Users\Lauri\Desktop\vault\04 Operating Contracts\mcp-current-topology.json',
    [switch]$CurrentPortFromTargetHost
)
$ErrorActionPreference='Stop'
function Health([int]$Port){ Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 3 }
function Get-CaddySiteBlockRange([string]$ConfigText,[string]$HostName){
    $match=[regex]::Match($ConfigText,"(?m)^\s*"+[regex]::Escape($HostName)+"\s*\{\s*\r?$")
    if(-not $match.Success){ throw "Caddy config is missing target host block: $HostName" }
    $depth=0;$started=$false
    for($i=$match.Index;$i -lt $ConfigText.Length;$i++){
        $ch=$ConfigText[$i]
        if($ch -eq '{'){ $depth++;$started=$true }
        elseif($ch -eq '}'){ $depth--; if($started -and $depth -eq 0){ return [pscustomobject]@{Start=$match.Index;Length=($i-$match.Index+1)} } }
    }
    throw "Caddy target host block is unterminated: $HostName"
}
function Get-CaddyTargetPort([string]$ConfigText,[string]$HostName){
    $range=Get-CaddySiteBlockRange $ConfigText $HostName
    $block=$ConfigText.Substring([int]$range.Start,[int]$range.Length)
    $matches=@([regex]::Matches($block,'(?im)^\s*reverse_proxy\s+127\.0\.0\.1:(?<port>\d+)\s*$'))
    if($matches.Count -ne 2){ throw "target host $HostName must contain exactly two loopback reverse_proxy routes; found $($matches.Count)" }
    $ports=@($matches | ForEach-Object {[int]$_.Groups['port'].Value} | Select-Object -Unique)
    if($ports.Count -ne 1){ throw "target host $HostName must use one unique backend port" }
    if($ports[0] -lt 1024 -or $ports[0] -gt 65535){ throw "target host backend port is invalid: $($ports[0])" }
    return [int]$ports[0]
}
function Replace-CaddyTargetUpstream([string]$ConfigText,[string]$HostName,[int]$CurrentPort,[int]$CandidatePort){
    $range=Get-CaddySiteBlockRange $ConfigText $HostName
    $block=$ConfigText.Substring([int]$range.Start,[int]$range.Length)
    $needle="127.0.0.1:$CurrentPort";$replacement="127.0.0.1:$CandidatePort"
    $count=([regex]::Matches($block,[regex]::Escape($needle))).Count
    if($count -ne 2){ throw "expected exactly two target-host upstream references to $needle; found $count" }
    $next=$block.Replace($needle,$replacement)
    return $ConfigText.Substring(0,[int]$range.Start)+$next+$ConfigText.Substring([int]$range.Start+[int]$range.Length)
}
if(-not (Test-Path -LiteralPath $CaddyConfigPath -PathType Leaf)){ throw "Caddy config missing: $CaddyConfigPath" }
if($CurrentPortFromTargetHost){
    $currentPort=Get-CaddyTargetPort (Get-Content -LiteralPath $CaddyConfigPath -Raw) $StableHost
    if($null -ne $ExpectedCurrentPort -and [int]$ExpectedCurrentPort -ne $currentPort){ throw "ExpectedCurrentPort disagrees with target host route: expected=$([int]$ExpectedCurrentPort) caddy=$currentPort host=$StableHost" }
}else{
    if(-not (Test-Path -LiteralPath $CurrentTopologyPath -PathType Leaf)){ throw "current topology missing: $CurrentTopologyPath" }
    $topology=Get-Content -LiteralPath $CurrentTopologyPath -Raw | ConvertFrom-Json
    if([string]$topology.schema -ne 'mcp-current-topology.v1' -or [string]$topology.authority -ne 'current_serving_topology'){ throw 'current topology contract is invalid' }
    $currentListen=[string]$topology.serving.backend.listen
    if($currentListen -notmatch '^127\.0\.0\.1:(?<port>[0-9]+)$'){ throw "current topology backend listen is unsupported: $currentListen" }
    $topologyCurrentPort=[int]$Matches.port
    if($topologyCurrentPort -lt 1024 -or $topologyCurrentPort -gt 65535){ throw "current topology backend port is invalid: $topologyCurrentPort" }
    $currentPort=$topologyCurrentPort
    if($null -ne $ExpectedCurrentPort){
        $requestedCurrentPort=[int]$ExpectedCurrentPort
        if($requestedCurrentPort -lt 1024 -or $requestedCurrentPort -gt 65535){ throw "ExpectedCurrentPort is invalid: $requestedCurrentPort" }
        if($requestedCurrentPort -ne $topologyCurrentPort){ throw "ExpectedCurrentPort disagrees with current topology: expected=$requestedCurrentPort topology=$topologyCurrentPort" }
        $currentPort=$requestedCurrentPort
    }
}
function Load-Caddy([string]$Config){
    & $CaddyExe validate --config $Config --adapter caddyfile | Out-Null
    if($LASTEXITCODE -ne 0){ throw "Caddy validation failed: $Config" }
    $json=Join-Path $env:TEMP ("mcp-home-direct-caddy-{0}.json" -f [guid]::NewGuid().ToString('N'))
    try {
        $adapted=@(& $CaddyExe adapt --config $Config --adapter caddyfile --pretty)
        if($LASTEXITCODE -ne 0){ throw 'Caddy adaptation failed' }
        $adaptedText=([string]::Join("`n",[string[]]$adapted)+"`n")
        [IO.File]::WriteAllText($json,$adaptedText,(New-Object Text.UTF8Encoding($false)))
        & curl.exe -fsS --max-time 5 -H 'Content-Type: application/json' --data-binary ("@$json") 'http://127.0.0.1:2019/load' | Out-Null
        if($LASTEXITCODE -ne 0){ throw 'Caddy admin load failed' }
    } finally { Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue }
}
if($CandidatePort -eq $currentPort){ throw 'candidate must use an alternate port' }
if(-not (Test-Path -LiteralPath $CaddyConfigPath -PathType Leaf)){ throw "Caddy config missing: $CaddyConfigPath" }
if(-not (Test-Path -LiteralPath $CaddyExe -PathType Leaf)){ throw "Caddy executable missing: $CaddyExe" }
$current=Health $currentPort
$candidate=Health $CandidatePort
$rollback=Health $IndependentRollbackPort
if($current.status -ne 'ok' -or [int]$current.port -ne $currentPort){ throw 'current backend health proof failed' }
if($candidate.status -ne 'ok' -or [int]$candidate.port -ne $CandidatePort -or [string]$candidate.backend_generation -ne $CandidateGeneration){ throw 'candidate health/generation proof failed' }
if($rollback.status -ne 'ok' -or [int]$rollback.port -ne $IndependentRollbackPort){ throw 'independent rollback health proof failed' }
$gateText = & python $StackAtlasPath production-change-gate mcp --actor $Actor --busy-scope $BusyScope --explicit-user-authorization --independent-rollback-verified --offpath-proof-verified
if($LASTEXITCODE -ne 0){ throw 'production change gate execution failed' }
$gate=$gateText | ConvertFrom-Json
if($gate.verdict -ne 'PASS'){ throw ("production change gate blocked: " + (($gate.reasons) -join ',')) }
$original=[IO.File]::ReadAllText($CaddyConfigPath)
$candidateText=Replace-CaddyTargetUpstream $original $StableHost $currentPort $CandidatePort
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
    [pscustomobject]@{status='PASS';candidate_port=$CandidatePort;candidate_generation=$CandidateGeneration;old_port=$currentPort;rollback_port=$IndependentRollbackPort;public_port=[int]$public.port;public_generation=[string]$public.backend_generation;caddy_backup=$backup;old_backend_action='PRESERVE_FOR_ROLLBACK'} | ConvertTo-Json -Compress
} catch {
    try {
        $rollbackConfig=Join-Path $env:TEMP ("mcp-home-direct-rollback-{0}.Caddyfile" -f [guid]::NewGuid().ToString('N'))
        [IO.File]::WriteAllText($rollbackConfig,$original,(New-Object Text.UTF8Encoding($false)))
        try { Load-Caddy $rollbackConfig } finally { Remove-Item -LiteralPath $rollbackConfig -Force -ErrorAction SilentlyContinue }
    } catch { }
    throw
} finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
