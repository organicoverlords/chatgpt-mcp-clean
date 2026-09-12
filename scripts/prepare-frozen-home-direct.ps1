[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$CandidateRoot,
    [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ExpectedCommit,
    [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$InstanceId,
    [string]$TaskName = '',
    [string]$DeploymentRoot = '',
    [string]$PublicOrigin = 'https://91-159-12-133.sslip.io',
    [string]$OAuthStoreRelative = 'home-direct-test\\oauth.json',
    [string]$CurrentTopologyPath = 'C:\Users\Lauri\Desktop\vault\04 Operating Contracts\mcp-current-topology.json',
    [switch]$ExplicitUserAuthorization,
    [switch]$Plan
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Fail([string]$Message){ throw $Message }
function Read-Topology([string]$Path){
    if(-not (Test-Path -LiteralPath $Path -PathType Leaf)){ Fail "current topology missing: $Path" }
    $topology=Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if([string]$topology.schema -ne 'mcp-current-topology.v1' -or [string]$topology.authority -ne 'current_serving_topology'){ Fail 'current topology contract is invalid' }
    return $topology
}
function Assert-Candidate([string]$Root,[string]$Commit){
    $resolved=[IO.Path]::GetFullPath($Root)
    if(-not (Test-Path -LiteralPath $resolved -PathType Container)){ Fail "candidate root missing: $resolved" }
    $head=(& git.exe -C $resolved rev-parse HEAD).Trim().ToLowerInvariant()
    if($LASTEXITCODE -ne 0 -or $head -ne $Commit.ToLowerInvariant()){ Fail "candidate commit mismatch: expected=$Commit actual=$head" }
    $dirty=@(& git.exe -C $resolved status --porcelain=v1 --untracked-files=no)
    if($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0){ Fail 'candidate tracked files must be clean' }
    return $resolved
}
$commit=$ExpectedCommit.ToLowerInvariant()
$short=$commit.Substring(0,7)
if(-not $TaskName){ $TaskName="McpV4FrozenStable${Port}-${short}" }
if(-not $DeploymentRoot){ $DeploymentRoot=Join-Path $env:LOCALAPPDATA ("ChatGPTMcpFrozen\\{0}" -f $short) }
$DeploymentRoot=[IO.Path]::GetFullPath($DeploymentRoot)
$root=Assert-Candidate $CandidateRoot $commit
$topology=Read-Topology $CurrentTopologyPath
$currentFrozen=[Environment]::ExpandEnvironmentVariables([string]$topology.serving.backend.durable_runtime_root)
$ownerLoginSource=Join-Path $currentFrozen 'owner-login.txt'
if(-not (Test-Path -LiteralPath $ownerLoginSource -PathType Leaf)){ Fail "current frozen owner identity missing: $ownerLoginSource" }
$ownerLogin=(Get-Content -LiteralPath $ownerLoginSource -Raw).Trim()
if([string]::IsNullOrWhiteSpace($ownerLogin)){ Fail 'current frozen owner identity is empty' }
$listener=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $Port } | Select-Object -First 1
if($listener){ Fail "candidate port already listening: $Port" }
if(Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue){ Fail "candidate task already exists: $TaskName" }
if(Test-Path -LiteralPath $DeploymentRoot){ Fail "deployment root already exists: $DeploymentRoot" }
$planResult=[ordered]@{
    status='PLAN'; commit=$commit; source_root=$root; deployment_root=$DeploymentRoot; runtime_root=(Join-Path $DeploymentRoot 'runtime');
    task_name=$TaskName; port=$Port; instance_id=$InstanceId; public_origin=$PublicOrigin; oauth_store_relative=$OAuthStoreRelative;
    current_serving_listen=[string]$topology.serving.backend.listen; current_frozen_root=$currentFrozen; route_mutation=$false
}
if($Plan){ $planResult | ConvertTo-Json -Depth 5 -Compress; exit 0 }
if(-not $ExplicitUserAuthorization){ Fail 'preparing a persistent production candidate task requires explicit user authorization' }
$parent=Split-Path -Parent $DeploymentRoot
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$staging="$DeploymentRoot.prepare-$([guid]::NewGuid().ToString('N'))"
try {
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $runtime=Join-Path $staging 'runtime'
    & git.exe clone --local --no-hardlinks --no-checkout $root $runtime | Out-Null
    if($LASTEXITCODE -ne 0){ Fail 'failed to create independent frozen runtime clone' }
    & git.exe -C $runtime checkout --detach $commit | Out-Null
    if($LASTEXITCODE -ne 0){ Fail 'failed to checkout frozen runtime commit' }
    & npm.cmd --prefix $runtime ci --no-audit --no-fund | Out-Null
    if($LASTEXITCODE -ne 0){ Fail 'npm ci failed for frozen runtime' }
    & npm.cmd --prefix $runtime run build --silent
    if($LASTEXITCODE -ne 0){ Fail 'build failed for frozen runtime' }
    Push-Location -LiteralPath $runtime
    try {
        & node.exe (Join-Path $runtime 'scripts\\verify-process-contract.mjs') | Out-Null
        if($LASTEXITCODE -ne 0){ Fail 'frozen runtime process contract verification failed' }
    } finally {
        Pop-Location
    }
    $runtimeHead=(& git.exe -C $runtime rev-parse HEAD).Trim().ToLowerInvariant()
    $runtimeDirty=@(& git.exe -C $runtime status --porcelain=v1 --untracked-files=no)
    if($runtimeHead -ne $commit -or $runtimeDirty.Count -gt 0){ Fail 'frozen runtime identity is not exact/clean' }
    $hashes=[ordered]@{
        dist_index_sha256=(Get-FileHash -LiteralPath (Join-Path $runtime 'dist\\index.js') -Algorithm SHA256).Hash.ToLowerInvariant()
        dist_server_sha256=(Get-FileHash -LiteralPath (Join-Path $runtime 'dist\\server.js') -Algorithm SHA256).Hash.ToLowerInvariant()
        process_manager_sha256=(Get-FileHash -LiteralPath (Join-Path $runtime 'dist\\lib\\process-manager.js') -Algorithm SHA256).Hash.ToLowerInvariant()
        package_lock_sha256=(Get-FileHash -LiteralPath (Join-Path $runtime 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    Copy-Item -LiteralPath $ownerLoginSource -Destination (Join-Path $staging 'owner-login.txt')
    $manifest=[ordered]@{
        schema='mcp-frozen-deployment.v1'; frozen_at=[DateTimeOffset]::UtcNow.ToString('o'); source_repo='organicoverlords/chatgpt-mcp-clean'; canonical_branch='master'; merge_commit=$commit;
        runtime_root=(Join-Path $DeploymentRoot 'runtime'); runtime_tracked_clean=$true; hashes=[ordered]@{dist_index_sha256=$hashes.dist_index_sha256;dist_server_sha256=$hashes.dist_server_sha256};
        routes=[ordered]@{stable=[ordered]@{public_origin=$PublicOrigin;port=$Port;instance=$InstanceId;oauth_store=(Join-Path $env:LOCALAPPDATA ("ChatGPTMcpClean\\minimal-connectors\\$OAuthStoreRelative"));rollback_port=([int](([string]$topology.recovery.stable_rollback.listen -split ':')[-1]));rollback_instance=[string]$topology.recovery.stable_rollback.instance}};
        tool_contract=@('start_process','read_output','kill_process','upload_local_file','download_chatgpt_file'); self_contained_runtime=(Join-Path $DeploymentRoot 'runtime'); runtime_commit=$commit;
        process_manager_sha256=$hashes.process_manager_sha256; package_lock_sha256=$hashes.package_lock_sha256
    }
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $staging 'deployment.json') -Encoding utf8
    $launcher=@"
[CmdletBinding()]
param()
`$ErrorActionPreference='Stop'
`$root=`$PSScriptRoot
`$runtime=Join-Path `$root 'runtime'
`$m=Get-Content -LiteralPath (Join-Path `$root 'deployment.json') -Raw | ConvertFrom-Json
function Assert-Hash([string]`$Relative,[string]`$Expected){`$actual=(Get-FileHash -LiteralPath (Join-Path `$runtime `$Relative) -Algorithm SHA256).Hash.ToLowerInvariant();if(`$actual -ne `$Expected){throw "frozen hash mismatch: `$Relative"}}
if((git.exe -C `$runtime rev-parse HEAD).Trim().ToLowerInvariant() -ne '$commit'){throw 'frozen runtime commit mismatch'}
if(@(git.exe -C `$runtime status --porcelain=v1 --untracked-files=no).Count -gt 0){throw 'frozen runtime tracked files are dirty'}
Assert-Hash 'dist\\index.js' ([string]`$m.hashes.dist_index_sha256)
Assert-Hash 'dist\\server.js' ([string]`$m.hashes.dist_server_sha256)
Assert-Hash 'dist\\lib\\process-manager.js' ([string]`$m.process_manager_sha256)
Assert-Hash 'package-lock.json' ([string]`$m.package_lock_sha256)
`$owner=(Get-Content -LiteralPath (Join-Path `$root 'owner-login.txt') -Raw).Trim();if([string]::IsNullOrWhiteSpace(`$owner)){throw 'protected owner-login identity empty'}
`$env:TAILSCALE_OWNER_LOGIN=`$owner;`$env:MCP_OWNER_AUTH_ORIGIN='';`$env:MCP_OWNER_AUTH_MODE='local-edge'
`$stateRoot=Join-Path `$env:LOCALAPPDATA 'ChatGPTMcpClean\\minimal-connectors';`$oauth=Join-Path `$stateRoot '$OAuthStoreRelative';`$receipts=Join-Path `$stateRoot 'shared-process-receipts'
& (Join-Path `$runtime 'scripts\\start-minimal-clone.ps1') -InstanceId '$InstanceId' -Port $Port -PublicOrigin '$PublicOrigin' -StateRoot `$stateRoot -OAuthStorePath `$oauth -SharedReceiptDirectory `$receipts -SkipBuild -RestartOnUnexpectedExit -RestartBackoffSeconds 2 -RestartLimit 0
exit `$LASTEXITCODE
"@
    [IO.File]::WriteAllText((Join-Path $staging 'start-stable.ps1'),$launcher.Replace("`r`n","`n"),(New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $staging -Destination $DeploymentRoot
    $pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
    $args='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $DeploymentRoot 'start-stable.ps1')
    $trigger=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action (New-ScheduledTaskAction -Execute $pwsh -Argument $args -WorkingDirectory (Join-Path $DeploymentRoot 'runtime')) -Trigger $trigger -Principal $principal -Settings $settings -Description "Frozen MCPv4 candidate $short on port $Port; route unchanged until explicit home-direct cutover" -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    $health=$null
    for($i=0;$i -lt 60;$i++){
        try{$health=Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 2;if($health.status -eq 'ok' -and [int]$health.port -eq $Port){break}}catch{}
        Start-Sleep -Milliseconds 500
    }
    if(-not $health -or $health.status -ne 'ok' -or [int]$health.port -ne $Port){ Fail "persistent candidate did not become healthy on port $Port" }
    if([string]$health.runtime_identity.source_commit -ne $commit){ Fail "persistent candidate source commit mismatch: $($health.runtime_identity.source_commit)" }
    [ordered]@{status='READY';commit=$commit;deployment_root=$DeploymentRoot;task_name=$TaskName;port=$Port;instance_id=$InstanceId;backend_generation=[string]$health.backend_generation;dist_sha256=[string]$health.runtime_identity.dist_sha256;route_mutation=$false} | ConvertTo-Json -Compress
} catch {
    if(Test-Path -LiteralPath $staging){ Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    throw
}
