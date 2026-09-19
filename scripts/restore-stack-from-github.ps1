[CmdletBinding()]
param(
    [string]$PublicOrigin = '',
    [string]$OwnerLogin = '',
    [string]$McpRepository = 'https://github.com/organicoverlords/chatgpt-mcp-clean.git',
    [string]$McpRef = 'master',
    [string]$RulesRepository = 'https://github.com/organicoverlords/agents.git',
    [string]$RulesRef = 'main',
    [string]$VaultRepository = 'https://github.com/organicoverlords/regression-research.git',
    [string]$VaultRef = 'main',
    [string]$SourceRoot = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpRecoverySource'),
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpStack'),
    [string]$BusyRoot = (Join-Path $env:LOCALAPPDATA 'BusyCoordinator'),
    [string]$RulesRoot = (Join-Path $env:USERPROFILE '.agents'),
    [string]$VaultRoot = (Join-Path $env:USERPROFILE 'Desktop\vault'),
    [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$InstanceId = 'home-direct',
    [ValidateRange(1024,65535)][int]$Port = 3022,
    [ValidateRange(1024,65535)][int]$CaddyHttpsPort = 8443,
    [string]$TaskName = 'ChatGPTMcpStack',
    [string]$CaddyTaskName = 'ChatGPTMcpStackCaddy',
    [string]$RulesSyncTaskName = 'ChatGPTMcpStackRulesSync',
    [string]$FirewallRuleName = 'ChatGPT MCP Caddy HTTPS',
    [switch]$RestoreUserContext,
    [switch]$SkipFirewall,
    [switch]$NoAutostart,
    [switch]$NoStart,
    [switch]$Plan
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Command([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { throw "required command is missing: $Name" }
    return $command.Source
}

function Invoke-Git([string[]]$Arguments) {
    & git.exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "git failed: git $($Arguments -join ' ')" }
}

function Assert-CleanCheckout([string]$Root) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
        throw "existing recovery path is not a Git checkout; preserved without changes: $Root"
    }
    $dirty = @(& git.exe -C $Root status --porcelain=v1 --untracked-files=normal)
    if ($LASTEXITCODE -ne 0) { throw "cannot inspect checkout: $Root" }
    if ($dirty.Count -gt 0) {
        throw "checkout has local work; preserved without reset/clean: $Root"
    }
}

function Ensure-Checkout([string]$Root,[string]$Repository,[string]$Ref) {
    if (-not (Test-Path -LiteralPath $Root)) {
        $parent = Split-Path -Parent ([IO.Path]::GetFullPath($Root))
        if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Invoke-Git @('clone','--branch',$Ref,'--single-branch',$Repository,$Root)
    } else {
        Assert-CleanCheckout $Root
        Invoke-Git @('-C',$Root,'fetch','origin',$Ref)
        $branch = ((& git.exe -C $Root branch --show-current) | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "cannot inspect branch: $Root" }
        if ($branch -ne $Ref) {
            $localRef = & git.exe -C $Root rev-parse --verify "refs/heads/$Ref" 2>$null
            if ($LASTEXITCODE -eq 0 -and $localRef) { Invoke-Git @('-C',$Root,'switch',$Ref) }
            else { Invoke-Git @('-C',$Root,'switch','-c',$Ref,'--track',"origin/$Ref") }
        }
        Invoke-Git @('-C',$Root,'merge','--ff-only',"origin/$Ref")
    }
    Assert-CleanCheckout $Root
    return (& git.exe -C $Root rev-parse HEAD).Trim().ToLowerInvariant()
}

function Read-JsonIfPresent([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw "invalid JSON: $Path :: $($_.Exception.Message)" }
}

function Read-CurrentTopology([string]$Root) {
    $path = Join-Path $Root '04 Operating Contracts\mcp-current-topology.json'
    $topology = Read-JsonIfPresent $path
    if (-not $topology) { return $null }
    if ([string]$topology.schema -ne 'mcp-current-topology.v1' -or [string]$topology.authority -ne 'current_serving_topology') {
        throw "Vault current-topology authority is invalid: $path"
    }
    return $topology
}

function Resolve-PublicOrigin([string]$Requested,$Topology,$ExistingConfig) {
    if (-not [string]::IsNullOrWhiteSpace($Requested)) { return $Requested.TrimEnd('/') }
    if ($Topology -and $Topology.serving -and -not [string]::IsNullOrWhiteSpace([string]$Topology.serving.public_origin)) {
        return ([string]$Topology.serving.public_origin).TrimEnd('/')
    }
    if ($ExistingConfig -and -not [string]::IsNullOrWhiteSpace([string]$ExistingConfig.public_origin)) {
        return ([string]$ExistingConfig.public_origin).TrimEnd('/')
    }
    throw 'PublicOrigin is required when it cannot be recovered from Vault current topology or an existing stack-config.json'
}

function Resolve-OwnerLogin([string]$Requested,$Topology,$ExistingConfig) {
    if (-not [string]::IsNullOrWhiteSpace($Requested)) { return $Requested.Trim() }
    if ($ExistingConfig -and -not [string]::IsNullOrWhiteSpace([string]$ExistingConfig.owner_login)) {
        return ([string]$ExistingConfig.owner_login).Trim()
    }
    if ($Topology -and $Topology.serving -and $Topology.serving.backend) {
        $frozenRoot = [Environment]::ExpandEnvironmentVariables([string]$Topology.serving.backend.durable_runtime_root)
        if (-not [string]::IsNullOrWhiteSpace($frozenRoot)) {
            $ownerPath = Join-Path $frozenRoot 'owner-login.txt'
            if (Test-Path -LiteralPath $ownerPath -PathType Leaf) {
                $owner = (Get-Content -LiteralPath $ownerPath -Raw).Trim()
                if (-not [string]::IsNullOrWhiteSpace($owner)) { return $owner }
            }
        }
    }
    throw 'OwnerLogin is required when no preserved local stack/frozen owner identity survives. It is intentionally not recovered from public GitHub.'
}

$planResult = [ordered]@{
    ok = $true
    plan_only = $true
    no_mutation = $true
    purpose = 'restore supported functional MCP stack plus optional user instructions/control context from GitHub'
    repositories = [ordered]@{
        mcp = [ordered]@{ repository=$McpRepository; ref=$McpRef; root=$SourceRoot }
        rules = [ordered]@{ repository=$RulesRepository; ref=$RulesRef; root=$RulesRoot }
        vault = [ordered]@{ repository=$VaultRepository; ref=$VaultRef; root=$VaultRoot; enabled=[bool]$RestoreUserContext }
    }
    install = [ordered]@{ root=$InstallRoot; busy_root=$BusyRoot; instance_id=$InstanceId; port=$Port; caddy_https_port=$CaddyHttpsPort; task=$TaskName; caddy_task=$CaddyTaskName; rules_sync_task=$RulesSyncTaskName }
    preserves = @(
        'dirty Git checkouts: fail closed; never reset/clean them',
        'existing OAuth/token stores: never restore/copy/delete backups automatically',
        'existing foreign/frozen runtimes and rollback artifacts',
        'router/DNS/firewall state except the supported installer firewall rule when requested'
    )
    functional_restore = @('MCP process profile','local Caddy','BusyCoordinator','agent rules/contracts','PlanOnly','autostart')
    user_context_restore = $(if ($RestoreUserContext) { @('Vault checkout','durable user directives/operating contracts','Stack Atlas entrypoints','Vault checkout sync','bootstrap snapshot tasks') } else { @() })
    redundant_bindings = 'second-stage only; read Vault mcp-current-topology.json and never hard-code historical ports/commits'
    completion_gate = @(
        'prove live route/runtime/task/OAuth/receipt identity and independent rollback',
        'prove runtime priority hardening and lossless COMPLETE bootstrap paging on restored serving bindings',
        'preserve old backends until running-process continuity is proved through the correct receipt/control directory',
        'reconcile mcp-current-topology.json, mcp-recovery-state.json, Stack Atlas/Vault and current install/restore/update instructions',
        'audit current docs/contracts for stale serving ports, commits, task names and broad Busy scopes; leave historical evidence unchanged'
    )
    reconciliation_required = $true
}
if ($Plan) {
    $planResult | ConvertTo-Json -Depth 7
    exit 0
}

if ($env:OS -ne 'Windows_NT') { throw 'restore-stack-from-github.ps1 supports Windows only' }
Require-Command 'pwsh.exe' | Out-Null
Require-Command 'git.exe' | Out-Null
Require-Command 'node.exe' | Out-Null
Require-Command 'npm.cmd' | Out-Null
if (-not (Get-Command python.exe -ErrorAction SilentlyContinue) -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'required command is missing: Python'
}

$mcpCommit = Ensure-Checkout $SourceRoot $McpRepository $McpRef
$topology = $null
if ($RestoreUserContext) {
    $null = Ensure-Checkout $VaultRoot $VaultRepository $VaultRef
    $topology = Read-CurrentTopology $VaultRoot
}

$existingConfigPath = Join-Path $InstallRoot 'stack-config.json'
$existingConfig = Read-JsonIfPresent $existingConfigPath
$resolvedOrigin = Resolve-PublicOrigin $PublicOrigin $topology $existingConfig
$resolvedOwner = Resolve-OwnerLogin $OwnerLogin $topology $existingConfig

$installer = Join-Path $SourceRoot 'scripts\install-stack.ps1'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "MCP installer implementation missing: $installer" }
$installArgs = @{
    PublicOrigin = $resolvedOrigin
    OwnerLogin = $resolvedOwner
    InstallRoot = $InstallRoot
    BusyRoot = $BusyRoot
    RulesRoot = $RulesRoot
    RulesRepository = $RulesRepository
    RulesRef = $RulesRef
    InstanceId = $InstanceId
    Port = $Port
    CaddyHttpsPort = $CaddyHttpsPort
    TaskName = $TaskName
    CaddyTaskName = $CaddyTaskName
    RulesSyncTaskName = $RulesSyncTaskName
    FirewallRuleName = $FirewallRuleName
}
if ($RestoreUserContext) { $installArgs.WithAgentEntrypoints = $true }
if ($SkipFirewall) { $installArgs.SkipFirewall = $true }
if ($NoAutostart) { $installArgs.NoAutostart = $true }
if ($NoStart) { $installArgs.NoStart = $true }
& $installer @installArgs
if ($LASTEXITCODE -ne 0) { throw "supported MCP stack installer failed: exit=$LASTEXITCODE" }

$userContext = [ordered]@{ enabled=[bool]$RestoreUserContext }
if ($RestoreUserContext) {
    $agentEntrypoints = Join-Path $RulesRoot 'Install-AgentEntrypoints.ps1'
    $atlasPath = Join-Path $VaultRoot 'tools\stack_atlas.py'
    foreach ($required in @($agentEntrypoints,$atlasPath,(Join-Path $VaultRoot 'tools\Install-VaultCheckoutSyncTask.ps1'),(Join-Path $VaultRoot 'tools\install_bootstrap_snapshot_task.ps1'))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "user-context recovery dependency missing: $required" }
    }
    & $agentEntrypoints -CanonicalRoot $RulesRoot -StackAtlasPath $atlasPath
    if ($LASTEXITCODE -ne 0) { throw 'agent/Stack Atlas entrypoint restoration failed' }
    & (Join-Path $VaultRoot 'tools\Install-VaultCheckoutSyncTask.ps1') -RepoRoot $VaultRoot
    if ($LASTEXITCODE -ne 0) { throw 'Vault checkout sync task restoration failed' }
    & (Join-Path $VaultRoot 'tools\install_bootstrap_snapshot_task.ps1') -RepoRoot $VaultRoot -StartNow
    if ($LASTEXITCODE -ne 0) { throw 'Vault bootstrap snapshot task restoration failed' }
    $userContext.stack_atlas = $atlasPath
    $userContext.current_topology = Join-Path $VaultRoot '04 Operating Contracts\mcp-current-topology.json'
    $userContext.recovery_state = Join-Path $VaultRoot '04 Operating Contracts\mcp-recovery-state.json'
    $userContext.directive_authority = 'Vault durable memory/directive records; current user direction outranks stale history'
}

$doctor = Join-Path $InstallRoot 'mcp\scripts\stack-doctor.ps1'
if (-not (Test-Path -LiteralPath $doctor -PathType Leaf)) { throw "stack doctor missing after install: $doctor" }
if (-not $NoStart -and -not $NoAutostart) {
    & $doctor -ConfigPath $existingConfigPath -RequireHealthyRuntime
} else {
    & $doctor -ConfigPath $existingConfigPath
}
if ($LASTEXITCODE -ne 0) { throw 'stack doctor reported a recovery failure' }

$oauthRoot = Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors'
$preservedOauth = @()
if (Test-Path -LiteralPath $oauthRoot -PathType Container) {
    foreach ($relative in @('home-direct-test\oauth.json','pr237-test\oauth.json','supertest9000-isolated\oauth.json','mcpx-isolated\oauth.json')) {
        $path = Join-Path $oauthRoot $relative
        if (Test-Path -LiteralPath $path -PathType Leaf) { $preservedOauth += $path }
    }
}

$result = [ordered]@{
    ok = $true
    source_commit = $mcpCommit
    public_origin = $resolvedOrigin
    install_root = $InstallRoot
    rules_root = $RulesRoot
    user_context = $userContext
    preserved_existing_oauth_files = $preservedOauth
    oauth_policy = 'No OAuth/token backup was copied, restored, deleted, or merged. If authorization state is missing, reconnect/authorize the ChatGPT connector after the endpoint is healthy.'
    current_topology_policy = 'If Vault is restored, mcp-current-topology.json is current serving authority; mcp-recovery-state.json is recovery metadata only.'
    control_recovery = 'One healthy process binding is enough to regain control. Restore redundant/frozen bindings only as a second stage from current topology and current source with existing production gates.'
    reconciliation_required = $true
    completion_gate = @(
        'prove live route/runtime/task/OAuth/receipt identity and independent rollback',
        'prove runtime priority hardening and lossless COMPLETE bootstrap paging on restored serving bindings',
        'preserve old backends until running-process continuity is proved through the correct receipt/control directory',
        'reconcile topology, recovery, Atlas/Vault and current install/restore/update guidance before declaring restore complete'
    )
}
$result | ConvertTo-Json -Depth 8
