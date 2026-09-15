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
    [string]$StackAtlasPath = (Join-Path $env:USERPROFILE 'Desktop\vault\tools\stack_atlas.py'),
    [string]$CurrentTopologyPath = (Join-Path $env:USERPROFILE 'Desktop\vault\04 Operating Contracts\mcp-current-topology.json'),
    [string]$CaddyAdminOrigin = 'http://127.0.0.1:2019',
    [string]$ExplicitUserAuthorizationEvidence = '',
    [switch]$CurrentPortFromTargetHost,
    [switch]$TargetLoadedRoute,
    [switch]$CreateTargetHost,
    [switch]$Plan
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
function Test-CaddyTargetHostExists([string]$ConfigText,[string]$HostName){
    return [regex]::IsMatch($ConfigText,"(?m)^\s*"+[regex]::Escape($HostName)+"\s*\{\s*\r?$")
}
function Find-CaddyReverseProxyDials($Node,[string]$Path,[System.Collections.Generic.List[object]]$Results){
    if($null -eq $Node){ return }
    if($Node -is [System.Collections.IEnumerable] -and -not ($Node -is [string]) -and -not ($Node -is [pscustomobject])){
        $i=0; foreach($item in $Node){ Find-CaddyReverseProxyDials $item "$Path/$i" $Results; $i++ }; return
    }
    if($Node -is [pscustomobject]){
        if([string]$Node.handler -eq 'reverse_proxy'){
            $upstreams=@($Node.upstreams)
            for($i=0;$i -lt $upstreams.Count;$i++){
                if($null -ne $upstreams[$i].dial){ $Results.Add([pscustomobject]@{path="$Path/upstreams/$i/dial";dial=[string]$upstreams[$i].dial}) }
            }
        }
        foreach($property in $Node.PSObject.Properties){ Find-CaddyReverseProxyDials $property.Value "$Path/$($property.Name)" $Results }
    }
}
function Get-LoadedCaddyTargetRoute([string]$HostName){
    $origin=$CaddyAdminOrigin.TrimEnd('/')
    $config=Invoke-RestMethod -Uri "$origin/config/" -TimeoutSec 3
    $matches=@()
    foreach($serverProperty in $config.apps.http.servers.PSObject.Properties){
        $routes=@($serverProperty.Value.routes)
        for($i=0;$i -lt $routes.Count;$i++){
            $hosts=@()
            foreach($matcher in @($routes[$i].match)){ if($null -ne $matcher.host){ $hosts += @($matcher.host) } }
            if($hosts -contains $HostName){ $matches += [pscustomobject]@{server=[string]$serverProperty.Name;route_index=$i;route=$routes[$i]} }
        }
    }
    if($matches.Count -ne 1){ throw "loaded Caddy config must contain exactly one target host route for $HostName; found $($matches.Count)" }
    $match=$matches[0]
    $routePath="/config/apps/http/servers/$($match.server)/routes/$($match.route_index)"
    $dials=[System.Collections.Generic.List[object]]::new()
    Find-CaddyReverseProxyDials $match.route $routePath $dials
    if($dials.Count -ne 2){ throw "loaded target host $HostName must contain exactly two reverse_proxy upstream dials; found $($dials.Count)" }
    $ports=@()
    foreach($dial in $dials){
        if([string]$dial.dial -notmatch '^127\.0\.0\.1:(?<port>[0-9]+)$'){ throw "loaded target host contains unsupported upstream: $([string]$dial.dial)" }
        $ports += [int]$Matches.port
    }
    $unique=@($ports | Select-Object -Unique)
    if($unique.Count -ne 1){ throw "loaded target host $HostName must use one unique backend port" }
    return [pscustomobject]@{port=[int]$unique[0];dial_paths=@($dials | ForEach-Object {$_.path});route_path=$routePath}
}
function Set-CaddyAdminDial([string]$Path,[int]$Port){
    $json=Join-Path $env:TEMP ("mcp-caddy-dial-{0}.json" -f [guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($json,('"127.0.0.1:{0}"' -f $Port),(New-Object Text.UTF8Encoding($false)))
        & curl.exe -fsS --max-time 5 -X PATCH -H 'Content-Type: application/json' --data-binary ("@$json") ($CaddyAdminOrigin.TrimEnd('/') + $Path) | Out-Null
        if($LASTEXITCODE -ne 0){ throw "Caddy admin dial patch failed: path=$Path port=$Port" }
    } finally { Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue }
}
function Add-CaddyTargetHost([string]$ConfigText,[string]$HostName,[int]$CandidatePort){
    if($HostName -notmatch '^[A-Za-z0-9.-]+$' -or $HostName.StartsWith('.') -or $HostName.EndsWith('.')){ throw "target host is invalid: $HostName" }
    if(Test-CaddyTargetHostExists $ConfigText $HostName){ throw "Caddy config already contains target host block: $HostName" }
    $block=@"

$HostName {
	@local_authorize {
		path /authorize
		remote_ip private_ranges
	}
	handle @local_authorize {
		reverse_proxy 127.0.0.1:$CandidatePort
	}
	@authorize path /authorize
	respond @authorize "Owner authorization required" 403
	handle {
		reverse_proxy 127.0.0.1:$CandidatePort
	}
}
"@
    return $ConfigText.TrimEnd()+$block+"`r`n"
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
$initialConfig=Get-Content -LiteralPath $CaddyConfigPath -Raw
$loadedTarget=$null
$persistedCurrentPort=$null
if($CreateTargetHost){
    if($CurrentPortFromTargetHost -or $TargetLoadedRoute){ throw 'CreateTargetHost cannot be combined with CurrentPortFromTargetHost or TargetLoadedRoute' }
    if($null -ne $ExpectedCurrentPort){ throw 'CreateTargetHost cannot be combined with ExpectedCurrentPort' }
    if(Test-CaddyTargetHostExists $initialConfig $StableHost){ throw "Caddy config already contains target host block: $StableHost" }
    $currentPort=$null
}elseif($TargetLoadedRoute){
    if($CurrentPortFromTargetHost){ throw 'TargetLoadedRoute cannot be combined with CurrentPortFromTargetHost' }
    $loadedTarget=Get-LoadedCaddyTargetRoute $StableHost
    $currentPort=[int]$loadedTarget.port
    $persistedCurrentPort=Get-CaddyTargetPort $initialConfig $StableHost
    if($null -ne $ExpectedCurrentPort -and [int]$ExpectedCurrentPort -ne $currentPort){ throw "ExpectedCurrentPort disagrees with loaded target host route: expected=$([int]$ExpectedCurrentPort) loaded=$currentPort host=$StableHost" }
}elseif($CurrentPortFromTargetHost){
    $currentPort=Get-CaddyTargetPort $initialConfig $StableHost
    $persistedCurrentPort=$currentPort
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
    $persistedCurrentPort=$currentPort
    if($null -ne $ExpectedCurrentPort){
        $requestedCurrentPort=[int]$ExpectedCurrentPort
        if($requestedCurrentPort -lt 1024 -or $requestedCurrentPort -gt 65535){ throw "ExpectedCurrentPort is invalid: $requestedCurrentPort" }
        if($requestedCurrentPort -ne $topologyCurrentPort){ throw "ExpectedCurrentPort disagrees with current topology: expected=$requestedCurrentPort topology=$topologyCurrentPort" }
        $currentPort=$requestedCurrentPort
    }
}
if($Plan){
    $planOriginal=[IO.File]::ReadAllText($CaddyConfigPath)
    $planPersistedPort=if($CreateTargetHost){$null}elseif($TargetLoadedRoute){[int]$persistedCurrentPort}else{[int]$currentPort}
    $planCandidateText=if($CreateTargetHost){ Add-CaddyTargetHost $planOriginal $StableHost $CandidatePort }else{ Replace-CaddyTargetUpstream $planOriginal $StableHost ([int]$planPersistedPort) $CandidatePort }
    [pscustomobject]@{status='PLAN';operation=$(if($CreateTargetHost){'ADD_ISOLATED_ROUTE'}elseif($TargetLoadedRoute){'REPLACE_LOADED_ROUTE'}else{'REPLACE_ROUTE'});target_host=$StableHost;candidate_port=$CandidatePort;old_port=$currentPort;persisted_old_port=$planPersistedPort;loaded_dial_paths=if($loadedTarget){@($loadedTarget.dial_paths)}else{@()};candidate_config=$planCandidateText} | ConvertTo-Json -Depth 5 -Compress
    exit 0
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
function Wait-CandidateLocalRoute([string]$HostName,[int]$ExpectedPort,[string]$ExpectedGeneration){
    $last='not attempted'
    for($i=0;$i -lt 40;$i++){
        $text=& curl.exe -ksS --max-time 2 --resolve ("{0}:8443:127.0.0.1" -f $HostName) ("https://{0}:8443/health" -f $HostName) 2>$null
        if($LASTEXITCODE -eq 0){
            try {
                $h=$text | ConvertFrom-Json
                if([int]$h.port -eq $ExpectedPort -and [string]$h.backend_generation -eq $ExpectedGeneration){ return $h }
                $last="route mismatch: port=$([int]$h.port) generation=$([string]$h.backend_generation)"
            } catch { $last=$_.Exception.Message }
        } else { $last="curl_exit=$LASTEXITCODE" }
        Start-Sleep -Milliseconds 500
    }
    throw "local HTTPS candidate route did not become ready: $last"
}
function Wait-CandidatePublicRoute([string]$Origin,[int]$ExpectedPort,[string]$ExpectedGeneration){
    $last='not attempted'
    for($i=0;$i -lt 40;$i++){
        try {
            $h=Invoke-RestMethod -Uri ($Origin.TrimEnd('/') + '/health') -TimeoutSec 3
            if([int]$h.port -eq $ExpectedPort -and [string]$h.backend_generation -eq $ExpectedGeneration){ return $h }
            $last="route mismatch: port=$([int]$h.port) generation=$([string]$h.backend_generation)"
        } catch { $last=$_.Exception.Message }
        Start-Sleep -Milliseconds 500
    }
    throw "public candidate route did not become ready: $last"
}
function Get-OwnedCaddyPid {
    $httpsOwners=@(Get-NetTCPConnection -State Listen -LocalPort 8443 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    $adminOwners=@(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort 2019 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    $shared=@($httpsOwners | Where-Object { $adminOwners -contains $_ } | Sort-Object -Unique)
    if($shared.Count -ne 1){ throw "cannot positively identify one Caddy owner for HTTPS/admin listeners; shared_pids=$($shared -join ',')" }
    $proc=Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$shared[0]) -ErrorAction Stop
    if(-not $proc -or [string]$proc.Name -ne 'caddy.exe'){ throw "listener owner is not caddy.exe: pid=$($shared[0]) name=$([string]$proc.Name)" }
    return [int]$shared[0]
}
function Assert-OriginalRoute([string]$HostName,[int]$ExpectedPort,[string]$ExpectedGeneration){
    $text=& curl.exe -ksS --max-time 4 --resolve ("{0}:8443:127.0.0.1" -f $HostName) ("https://{0}:8443/health" -f $HostName)
    if($LASTEXITCODE -ne 0){ throw 'original local HTTPS route probe failed' }
    $h=$text | ConvertFrom-Json
    if([int]$h.port -ne $ExpectedPort -or [string]$h.backend_generation -ne $ExpectedGeneration){ throw "original route proof mismatch: expected_port=$ExpectedPort actual_port=$([int]$h.port) expected_generation=$ExpectedGeneration actual_generation=$([string]$h.backend_generation)" }
}
function Restart-CaddyFromPersistentConfig([string]$OriginalConfig,[string]$ProofHost,[int]$ExpectedPort,[string]$ExpectedGeneration){
    if([IO.File]::ReadAllText($CaddyConfigPath) -ne $OriginalConfig){
        [IO.File]::WriteAllText($CaddyConfigPath,$OriginalConfig,(New-Object Text.UTF8Encoding($false)))
    }
    & $CaddyExe validate --config $CaddyConfigPath --adapter caddyfile | Out-Null
    if($LASTEXITCODE -ne 0){ throw 'persistent rollback Caddy configuration validation failed' }
    $ownedPid=Get-OwnedCaddyPid
    Stop-Process -Id $ownedPid -Force -ErrorAction Stop
    for($i=0;$i -lt 20;$i++){
        $still=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $ownedPid -and $_.LocalPort -in 8443,2019 })
        if($still.Count -eq 0){ break }
        Start-Sleep -Milliseconds 100
    }
    & $CaddyExe start --config $CaddyConfigPath --adapter caddyfile | Out-Null
    if($LASTEXITCODE -ne 0){ throw "persistent rollback Caddy start failed: exit=$LASTEXITCODE" }
    $last=''
    for($i=0;$i -lt 30;$i++){
        try { Assert-OriginalRoute $ProofHost $ExpectedPort $ExpectedGeneration; return } catch { $last=$_.Exception.Message }
        Start-Sleep -Milliseconds 200
    }
    throw "persistent rollback route did not recover: $last"
}
if($null -ne $currentPort -and $CandidatePort -eq [int]$currentPort){ throw 'candidate must use an alternate port' }
if($CandidatePort -eq $IndependentRollbackPort){ throw 'candidate must not reuse the independent rollback port' }
if(-not (Test-Path -LiteralPath $CaddyConfigPath -PathType Leaf)){ throw "Caddy config missing: $CaddyConfigPath" }
if(-not (Test-Path -LiteralPath $CaddyExe -PathType Leaf)){ throw "Caddy executable missing: $CaddyExe" }
if($CreateTargetHost){
    if(-not (Test-Path -LiteralPath $CurrentTopologyPath -PathType Leaf)){ throw "current topology missing: $CurrentTopologyPath" }
    $rollbackTopology=Get-Content -LiteralPath $CurrentTopologyPath -Raw | ConvertFrom-Json
    if([string]$rollbackTopology.schema -ne 'mcp-current-topology.v1' -or [string]$rollbackTopology.authority -ne 'current_serving_topology'){ throw 'current topology contract is invalid' }
    $rollbackListen=[string]$rollbackTopology.serving.backend.listen
    if($rollbackListen -notmatch '^127\.0\.0\.1:(?<port>[0-9]+)$'){ throw "current topology backend listen is unsupported: $rollbackListen" }
    $rollbackProofPort=[int]$Matches.port
    $rollbackOrigin=[string]$rollbackTopology.serving.public_origin
    try { $rollbackProofHost=([uri]$rollbackOrigin).Host } catch { throw "current topology public origin is invalid: $rollbackOrigin" }
    if([string]::IsNullOrWhiteSpace($rollbackProofHost)){ throw "current topology public origin has no host: $rollbackOrigin" }
}else{
    $rollbackProofPort=[int]$currentPort
    $rollbackProofHost=$StableHost
}
if($CandidatePort -eq $rollbackProofPort){ throw 'candidate must not reuse the rollback proof route port' }
$rollbackProof=Health $rollbackProofPort
if($rollbackProof.status -ne 'ok' -or [int]$rollbackProof.port -ne $rollbackProofPort){ throw 'rollback proof route health failed' }
if($null -ne $currentPort){
    $current=Health ([int]$currentPort)
    if($current.status -ne 'ok' -or [int]$current.port -ne [int]$currentPort){ throw 'current backend health proof failed' }
}
$candidate=Health $CandidatePort
$rollback=Health $IndependentRollbackPort
if($candidate.status -ne 'ok' -or [int]$candidate.port -ne $CandidatePort -or [string]$candidate.backend_generation -ne $CandidateGeneration){ throw 'candidate health/generation proof failed' }
if($rollback.status -ne 'ok' -or [int]$rollback.port -ne $IndependentRollbackPort){ throw 'independent rollback health proof failed' }
$gateArgs=@($StackAtlasPath,'production-change-gate','mcp','--actor',$Actor,'--busy-scope',$BusyScope)
if($CreateTargetHost){
    if([string]::IsNullOrWhiteSpace($ExplicitUserAuthorizationEvidence)){ throw 'CreateTargetHost requires explicit user authorization evidence' }
    $gateArgs += @('--explicit-user-authorization','--authorization-evidence',$ExplicitUserAuthorizationEvidence)
}else{
    $gateArgs += '--routine-scoped-advance'
}
$gateArgs += @('--independent-rollback-verified','--offpath-proof-verified')
$gateText = & python @gateArgs
if($LASTEXITCODE -ne 0){ throw 'production change gate execution failed' }
$gate=$gateText | ConvertFrom-Json
if($gate.verdict -ne 'PASS'){ throw ("production change gate blocked: " + (($gate.reasons) -join ',')) }
$original=[IO.File]::ReadAllText($CaddyConfigPath)
$persistedPortForReplace=if($TargetLoadedRoute){[int]$persistedCurrentPort}else{[int]$currentPort}
$candidateText=if($CreateTargetHost){ Add-CaddyTargetHost $original $StableHost $CandidatePort }else{ Replace-CaddyTargetUpstream $original $StableHost $persistedPortForReplace $CandidatePort }
$temp=Join-Path (Split-Path -Parent $CaddyConfigPath) ("Caddyfile.issue274-{0}.tmp" -f [guid]::NewGuid().ToString('N'))
$backup="$CaddyConfigPath.pre-home-direct-replace-$(Get-Date -Format yyyyMMddHHmmss)"
[IO.File]::WriteAllText($temp,$candidateText,(New-Object Text.UTF8Encoding($false)))
if($TargetLoadedRoute){
    & $CaddyExe validate --config $temp --adapter caddyfile | Out-Null
    if($LASTEXITCODE -ne 0){ throw "Caddy validation failed: $temp" }
    $patched=@()
    $persisted=$false
    try {
        foreach($dialPath in @($loadedTarget.dial_paths)){ Set-CaddyAdminDial $dialPath $CandidatePort; $patched += $dialPath }
        $loadedAfter=Get-LoadedCaddyTargetRoute $StableHost
        if([int]$loadedAfter.port -ne $CandidatePort){ throw "loaded route verification failed: expected=$CandidatePort actual=$([int]$loadedAfter.port)" }
        $local=Wait-CandidateLocalRoute $StableHost $CandidatePort $CandidateGeneration
        $public=Wait-CandidatePublicRoute $PublicOrigin $CandidatePort $CandidateGeneration
        Copy-Item -LiteralPath $CaddyConfigPath -Destination $backup
        Move-Item -LiteralPath $temp -Destination $CaddyConfigPath -Force
        $persisted=$true
        [pscustomobject]@{status='PASS';operation='REPLACE_LOADED_ROUTE';candidate_port=$CandidatePort;candidate_generation=$CandidateGeneration;old_port=$currentPort;persisted_old_port=$persistedCurrentPort;rollback_port=$IndependentRollbackPort;public_port=[int]$public.port;public_generation=[string]$public.backend_generation;caddy_backup=$backup;old_backend_action='PRESERVE_FOR_ROLLBACK';loaded_dial_paths=@($loadedTarget.dial_paths)} | ConvertTo-Json -Depth 4 -Compress
    } catch {
        $primaryError=$_.Exception
        $rollbackError=$null
        try {
            foreach($dialPath in @($patched)){ Set-CaddyAdminDial $dialPath ([int]$currentPort) }
            if($persisted){ [IO.File]::WriteAllText($CaddyConfigPath,$original,(New-Object Text.UTF8Encoding($false))) }
            Assert-OriginalRoute $StableHost ([int]$currentPort) ([string]$current.backend_generation)
        } catch { $rollbackError=$_.Exception }
        if($rollbackError){ throw "targeted home-direct cutover failed: $($primaryError.Message); targeted rollback also failed: $($rollbackError.Message)" }
        throw $primaryError
    } finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}else{
    try {
        Load-Caddy $temp
        $local=Wait-CandidateLocalRoute $StableHost $CandidatePort $CandidateGeneration
        $public=Wait-CandidatePublicRoute $PublicOrigin $CandidatePort $CandidateGeneration
        Copy-Item -LiteralPath $CaddyConfigPath -Destination $backup
        Move-Item -LiteralPath $temp -Destination $CaddyConfigPath -Force
        [pscustomobject]@{status='PASS';operation=$(if($CreateTargetHost){'ADD_ISOLATED_ROUTE'}else{'REPLACE_ROUTE'});candidate_port=$CandidatePort;candidate_generation=$CandidateGeneration;old_port=$currentPort;rollback_port=$IndependentRollbackPort;public_port=[int]$public.port;public_generation=[string]$public.backend_generation;caddy_backup=$backup;old_backend_action=$(if($CreateTargetHost){'NO_EXISTING_TARGET_ROUTE'}else{'PRESERVE_FOR_ROLLBACK'})} | ConvertTo-Json -Compress
    } catch {
        $primaryError=$_.Exception
        $rollbackError=$null
        try {
            $rollbackConfig=Join-Path $env:TEMP ("mcp-home-direct-rollback-{0}.Caddyfile" -f [guid]::NewGuid().ToString('N'))
            [IO.File]::WriteAllText($rollbackConfig,$original,(New-Object Text.UTF8Encoding($false)))
            try { Load-Caddy $rollbackConfig } finally { Remove-Item -LiteralPath $rollbackConfig -Force -ErrorAction SilentlyContinue }
            Assert-OriginalRoute $rollbackProofHost $rollbackProofPort ([string]$rollbackProof.backend_generation)
        } catch {
            $rollbackError=$_.Exception
            try {
                Restart-CaddyFromPersistentConfig $original $rollbackProofHost $rollbackProofPort ([string]$rollbackProof.backend_generation)
                $rollbackError=$null
            } catch { $rollbackError=$_.Exception }
        }
        if($rollbackError){ throw "home-direct cutover failed: $($primaryError.Message); independent persistent rollback also failed: $($rollbackError.Message)" }
        throw $primaryError
    } finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}
