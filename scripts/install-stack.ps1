[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PublicOrigin,
    [Parameter(Mandatory=$true)][string]$OwnerLogin,
    [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$InstanceId = 'home-direct',
    [ValidateRange(1024,65535)][int]$Port = 3022,
    [ValidateRange(1024,65535)][int]$CaddyHttpsPort = 8443,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpStack'),
    [string]$BusyRoot = (Join-Path $env:LOCALAPPDATA 'BusyCoordinator'),
    [string]$RulesRoot = (Join-Path $env:USERPROFILE '.agents'),
    [string]$RulesRepository = 'https://github.com/organicoverlords/agents.git',
    [string]$RulesRef = 'main',
    [string]$TaskName = 'ChatGPTMcpStack',
    [string]$CaddyTaskName = 'ChatGPTMcpStackCaddy',
    [string]$RulesSyncTaskName = 'ChatGPTMcpStackRulesSync',
    [string]$FirewallRuleName = 'ChatGPT MCP Caddy HTTPS',
    [switch]$WithAgentEntrypoints,
    [switch]$SkipFirewall,
    [switch]$NoAutostart,
    [switch]$NoStart,
    [switch]$Plan
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SourceRoot = Split-Path -Parent $PSScriptRoot

function Require-Command([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "required command is missing: $Name" }
    return $cmd.Source
}
function Invoke-Git([string[]]$Arguments) {
    & git.exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "git failed: git $($Arguments -join ' ')" }
}
function Assert-RulesCheckout([string]$Root,[string]$Repository,[string]$Ref) {
    if (-not (Test-Path -LiteralPath $Root)) {
        Invoke-Git @('clone','--branch',$Ref,'--single-branch',$Repository,$Root)
    } else {
        if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) { throw "rules root exists but is not a git checkout: $Root" }
        $dirty = @(& git.exe -C $Root status --porcelain=v1)
        if ($LASTEXITCODE -ne 0) { throw "cannot inspect rules checkout: $Root" }
        if ($dirty.Count -gt 0) { throw "rules checkout is dirty; preserve it and retry after resolving local work: $Root" }
        Invoke-Git @('-C',$Root,'fetch','origin',$Ref)
        $branch = ((& git.exe -C $Root branch --show-current) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "cannot inspect rules branch: $Root" }
        if ($branch -ne $Ref) { Invoke-Git @('-C',$Root,'switch',$Ref) }
        Invoke-Git @('-C',$Root,'merge','--ff-only',"origin/$Ref")
    }
    foreach ($required in @('RULES.md','AGENTS.md')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $required) -PathType Leaf)) { throw "rules checkout is missing $required" }
    }
}
function Copy-TrackedTree([string]$Source,[string]$Destination) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $files = @(& git.exe -C $Source ls-files)
    if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { throw 'cannot enumerate tracked MCP package files' }
    foreach ($relative in $files) {
        $src = Join-Path $Source $relative
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { throw "tracked source file is missing: $relative" }
        $dst = Join-Path $Destination $relative
        $parent = Split-Path -Parent $dst
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Copy-Item -LiteralPath $src -Destination $dst -Force
    }
}
function Swap-Directory([string]$Prepared,[string]$Target) {
    $old = "$Target.old-$([Guid]::NewGuid().ToString('N'))"
    if (Test-Path -LiteralPath $Target) { Move-Item -LiteralPath $Target -Destination $old }
    try { Move-Item -LiteralPath $Prepared -Destination $Target }
    catch {
        if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $Target)) { Move-Item -LiteralPath $old -Destination $Target }
        throw
    }
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
}
function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Write-LocalCaddyfile([string]$Path,[string]$HostName,[int]$HttpsPort,[int]$BackendPort) {
    $text = @"
{
    https_port $HttpsPort
    auto_https disable_redirects
}

$HostName {
    @local_authorize {
        path /authorize
        remote_ip private_ranges
    }
    handle @local_authorize {
        reverse_proxy 127.0.0.1:$BackendPort
    }
    @authorize path /authorize
    respond @authorize "Owner authorization required" 403
    handle {
        reverse_proxy 127.0.0.1:$BackendPort
    }
}
"@
    [IO.File]::WriteAllText($Path, $text.Replace("`r`n","`n"), (New-Object Text.UTF8Encoding($false)))
}

$origin = $null
try { $origin = [uri]$PublicOrigin } catch { throw 'PublicOrigin must be a valid HTTPS URL' }
if ($origin.Scheme -ne 'https' -or -not $origin.Host -or $origin.UserInfo -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment) { throw 'PublicOrigin must be an HTTPS origin without credentials, path, query, or fragment' }
if ([string]::IsNullOrWhiteSpace($OwnerLogin)) { throw 'OwnerLogin must not be empty' }
if ($Port -eq $CaddyHttpsPort) { throw 'MCP backend Port and CaddyHttpsPort must differ' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required on Windows' }
if (-not $env:USERPROFILE) { throw 'USERPROFILE is required on Windows' }

$pwsh = Require-Command 'pwsh.exe'
Require-Command 'node.exe' | Out-Null
Require-Command 'npm.cmd' | Out-Null
Require-Command 'git.exe' | Out-Null
if (-not (Get-Command python.exe -ErrorAction SilentlyContinue) -and -not (Get-Command python -ErrorAction SilentlyContinue)) { throw 'required command is missing: Python' }
$nodeVersion = (& node.exe -p "process.versions.node").Trim()
if ([int]($nodeVersion.Split('.')[0]) -lt 20) { throw "Node.js 20 or newer is required; found $nodeVersion" }

$sourceFull = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
$installFull = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($installFull.StartsWith($sourceFull + '\',[StringComparison]::OrdinalIgnoreCase) -or $installFull.Equals($sourceFull,[StringComparison]::OrdinalIgnoreCase)) { throw 'InstallRoot must be outside the source repository' }
$trackedDirty = @(& git.exe -C $SourceRoot status --porcelain=v1 --untracked-files=no)
if ($LASTEXITCODE -ne 0) { throw 'cannot inspect MCP source checkout' }
if (-not $Plan -and $trackedDirty.Count -gt 0) { throw 'installer requires a clean tracked source checkout; commit/stash tracked work before installing' }
$sourceCommit = ((& git.exe -C $SourceRoot rev-parse HEAD) | Out-String).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') { throw 'cannot resolve MCP source commit' }

$planProfileSource = Join-Path $SourceRoot 'stack\plan-only-profile.json'
$busySource = Join-Path $SourceRoot 'stack\busy'
$caddySpecPath = Join-Path $SourceRoot 'stack\caddy-package.json'
foreach ($required in @($planProfileSource,$caddySpecPath,(Join-Path $busySource 'busy-python.cmd'),(Join-Path $busySource 'python\busy.py'),(Join-Path $busySource 'coordinator-contract.json'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "package component missing: $required" }
}
$caddySpec = Get-Content -LiteralPath $caddySpecPath -Raw | ConvertFrom-Json
if ([string]$caddySpec.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'invalid pinned Caddy SHA-256' }

$actions = @(
    "install MCP runtime on loopback 127.0.0.1:$Port with exactly five connector tools",
    "install local Caddy $($caddySpec.version) on TCP $CaddyHttpsPort for $($origin.Host)",
    'use local-edge owner authorization; no VPS, WireGuard, or Tailscale owner-auth path',
    "install standalone BusyCoordinator into $BusyRoot",
    "install/update public agent rules checkout at $RulesRoot ($RulesRef)",
    "install PlanOnly profile into $InstallRoot\profiles\plan-only.json",
    $(if ($WithAgentEntrypoints) { 'install Codex/OpenCode pointer entrypoints' } else { 'leave agent entrypoints untouched (agentless-compatible)' }),
    $(if ($SkipFirewall) { "leave Windows Firewall unchanged; TCP $CaddyHttpsPort must already be allowed" } else { "ensure Windows Firewall allows inbound TCP $CaddyHttpsPort" }),
    $(if ($NoAutostart) { 'do not register autostart tasks' } else { "register $TaskName, $CaddyTaskName, and $RulesSyncTaskName" }),
    $(if ($NoStart -or $NoAutostart) { 'do not start MCP/Caddy now' } else { 'start MCP and local Caddy now' })
)
if ($Plan) {
    [ordered]@{ ok=$true; plan_only=$true; topology='local-home-direct'; tool_count=5; library_delivery='explicit file tools'; source_commit=$sourceCommit; actions=$actions; no_mutation=$true } | ConvertTo-Json -Depth 4
    exit 0
}

if (-not $SkipFirewall -and -not (Test-Administrator)) { throw "administrator rights are required once to create inbound TCP $CaddyHttpsPort; rerun elevated or use -SkipFirewall if already configured" }
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
foreach ($name in @($TaskName,$CaddyTaskName)) { if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue } }
Start-Sleep -Milliseconds 500

$preparedMcp = Join-Path $InstallRoot ("mcp.next-" + [Guid]::NewGuid().ToString('N'))
try {
    Copy-TrackedTree $SourceRoot $preparedMcp
    Push-Location $preparedMcp
    try {
        & npm.cmd ci --silent
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
        & npm.cmd run build --silent
        if ($LASTEXITCODE -ne 0) { throw 'MCP build failed' }
        & node.exe scripts/verify-process-contract.mjs
        if ($LASTEXITCODE -ne 0) { throw 'five-tool MCP connector contract verification failed' }
        & npm.cmd prune --omit=dev --silent
        if ($LASTEXITCODE -ne 0) { throw 'npm production prune failed' }
    } finally { Pop-Location }
    $distPath = Join-Path $preparedMcp 'dist\index.js'
    if (-not (Test-Path -LiteralPath $distPath -PathType Leaf)) { throw 'MCP build did not produce dist/index.js' }
    $distSha = (Get-FileHash -LiteralPath $distPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Swap-Directory $preparedMcp (Join-Path $InstallRoot 'mcp')
} finally {
    if (Test-Path -LiteralPath $preparedMcp) { Remove-Item -LiteralPath $preparedMcp -Recurse -Force -ErrorAction SilentlyContinue }
}

$busyParent = Split-Path -Parent ([IO.Path]::GetFullPath($BusyRoot))
if (-not (Test-Path -LiteralPath $busyParent)) { New-Item -ItemType Directory -Force -Path $busyParent | Out-Null }
$preparedBusy = "$BusyRoot.next-$([Guid]::NewGuid().ToString('N'))"
Copy-Item -LiteralPath $busySource -Destination $preparedBusy -Recurse -Force
$busyContractOut = @(& (Join-Path $preparedBusy 'busy-python.cmd') contract 2>&1)
if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $preparedBusy -Recurse -Force -ErrorAction SilentlyContinue; throw "BusyCoordinator contract check failed: $($busyContractOut -join ' ')" }
Swap-Directory $preparedBusy $BusyRoot

$profilesRoot = Join-Path $InstallRoot 'profiles'
New-Item -ItemType Directory -Force -Path $profilesRoot | Out-Null
$planProfile = Join-Path $profilesRoot 'plan-only.json'
Copy-Item -LiteralPath $planProfileSource -Destination $planProfile -Force
Assert-RulesCheckout $RulesRoot $RulesRepository $RulesRef
if ($WithAgentEntrypoints) {
    & (Join-Path $RulesRoot 'Install-AgentEntrypoints.ps1') -CanonicalRoot $RulesRoot
    if ($LASTEXITCODE -ne 0) { throw 'agent entrypoint installation failed' }
}

$caddyRoot = Join-Path $InstallRoot 'caddy'
$preparedCaddy = Join-Path $InstallRoot ("caddy.next-" + [Guid]::NewGuid().ToString('N'))
$tempZip = Join-Path $env:TEMP ("caddy-$([Guid]::NewGuid().ToString('N')).zip")
try {
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$caddySpec.url) -OutFile $tempZip
    $actualCaddyHash = (Get-FileHash -LiteralPath $tempZip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualCaddyHash -ne ([string]$caddySpec.sha256).ToLowerInvariant()) { throw "Caddy archive SHA-256 mismatch: expected=$($caddySpec.sha256) actual=$actualCaddyHash" }
    New-Item -ItemType Directory -Force -Path $preparedCaddy | Out-Null
    Expand-Archive -LiteralPath $tempZip -DestinationPath $preparedCaddy -Force
    $caddyExePrepared = Join-Path $preparedCaddy 'caddy.exe'
    if (-not (Test-Path -LiteralPath $caddyExePrepared -PathType Leaf)) { throw 'Caddy archive did not contain caddy.exe' }
    Write-LocalCaddyfile (Join-Path $preparedCaddy 'Caddyfile') $origin.Host $CaddyHttpsPort $Port
    & $caddyExePrepared validate --config (Join-Path $preparedCaddy 'Caddyfile') --adapter caddyfile | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'generated local Caddy configuration is invalid' }
    Swap-Directory $preparedCaddy $caddyRoot
} finally {
    Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $preparedCaddy) { Remove-Item -LiteralPath $preparedCaddy -Recurse -Force -ErrorAction SilentlyContinue }
}
$caddyExe = Join-Path $caddyRoot 'caddy.exe'
$caddyFile = Join-Path $caddyRoot 'Caddyfile'
if (-not $SkipFirewall) {
    Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $CaddyHttpsPort -Profile Any -Program $caddyExe | Out-Null
}

$stateRoot = Join-Path $InstallRoot 'state'
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\.state') | Out-Null
$configPath = Join-Path $InstallRoot 'stack-config.json'
$config = [ordered]@{
    schema_version = 2
    topology = 'local-home-direct'
    installed_at = [DateTimeOffset]::UtcNow.ToString('o')
    source_commit = $sourceCommit
    dist_sha256 = $distSha
    mcp_root = (Join-Path $InstallRoot 'mcp')
    busy_root = [IO.Path]::GetFullPath($BusyRoot)
    rules_root = [IO.Path]::GetFullPath($RulesRoot)
    plan_only_profile = $planProfile
    state_root = $stateRoot
    instance_id = $InstanceId
    port = $Port
    public_origin = $PublicOrigin.TrimEnd('/')
    owner_auth_mode = 'local-edge'
    owner_login = $OwnerLogin
    tool_profile = 'process'
    tool_count = 5
    library_delivery = 'explicit file tools'
    caddy_exe = $caddyExe
    caddy_config = $caddyFile
    caddy_https_port = $CaddyHttpsPort
    task_name = $TaskName
    caddy_task_name = $CaddyTaskName
    rules_sync_task_name = $RulesSyncTaskName
    firewall_rule_name = $(if ($SkipFirewall) { '' } else { $FirewallRuleName })
    autostart = (-not $NoAutostart)
    agent_entrypoints = [bool]$WithAgentEntrypoints
}
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8

if ($NoAutostart) {
    foreach ($name in @($TaskName,$CaddyTaskName,$RulesSyncTaskName)) { if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false } }
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    $mcpArgs = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f (Join-Path $InstallRoot 'mcp\scripts\start-stack.ps1'),$configPath
    Register-ScheduledTask -TaskName $TaskName -Action (New-ScheduledTaskAction -Execute $pwsh -Argument $mcpArgs -WorkingDirectory (Join-Path $InstallRoot 'mcp')) -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local ChatGPT MCP five-tool backend' -Force | Out-Null
    $caddyArgs = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}"' -f (Join-Path $InstallRoot 'mcp\scripts\start-stack-caddy.ps1'),$configPath
    Register-ScheduledTask -TaskName $CaddyTaskName -Action (New-ScheduledTaskAction -Execute $pwsh -Argument $caddyArgs -WorkingDirectory $caddyRoot) -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local ChatGPT MCP HTTPS Caddy edge' -Force | Out-Null
    & (Join-Path $RulesRoot 'Install-AgentRulesCheckoutSyncTask.ps1') -TaskName $RulesSyncTaskName -IntervalMinutes 1
    if ($LASTEXITCODE -ne 0) { throw 'agent rules sync task installation failed' }
    if (-not $NoStart) {
        Start-ScheduledTask -TaskName $TaskName
        $healthUri = "http://127.0.0.1:$Port/health"
        $healthy = $false
        for ($attempt=0; $attempt -lt 60; $attempt++) { try { $h=Invoke-RestMethod -Uri $healthUri -TimeoutSec 2; if ($h.status -eq 'ok') {$healthy=$true;break} } catch {}; Start-Sleep -Milliseconds 500 }
        if (-not $healthy) { throw "MCP backend did not become healthy: $healthUri" }
        Start-ScheduledTask -TaskName $CaddyTaskName
    }
}

$mcpUrl = "$($PublicOrigin.TrimEnd('/'))/mcp"
$doctor = Join-Path $InstallRoot 'mcp\scripts\stack-doctor.ps1'
& $doctor -ConfigPath $configPath
if ($LASTEXITCODE -ne 0) { throw 'stack doctor reported an installation failure' }
[ordered]@{
    ok=$true; topology='local-home-direct'; tool_count=5; tools=@('start_process','read_output','kill_process','upload_local_file','download_chatgpt_file')
    library_delivery='explicit file tools'; source_commit=$sourceCommit; install_root=$InstallRoot
    config_path=$configPath; mcp_url=$mcpUrl; local_health=("http://127.0.0.1:{0}/health" -f $Port); local_https_port=$CaddyHttpsPort
    busy_command=(Join-Path $BusyRoot 'busy-python.cmd'); rules_root=$RulesRoot; plan_only_profile=$planProfile
    agent_entrypoints=[bool]$WithAgentEntrypoints; autostart=(-not $NoAutostart)
    router_requirement="forward public TCP 443 to this Windows machine TCP $CaddyHttpsPort; no VPS is used"
} | ConvertTo-Json -Depth 5
