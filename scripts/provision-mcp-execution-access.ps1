param(
    [string]$PrincipalUserId = '',
    [string]$PrincipalSid = '',
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [Parameter(Mandatory=$true)][string]$StateRoot,
    [string]$ReplacementStateRoot = '',
    [string]$OAuthStorePath = '',
    [string]$EnvFilePath = '',
    [string]$CandidateRoot = '',
    [string]$EdgeOwnerPath = '',
    [string]$RecoveryStatePath = '',
    [string]$GateReceiptPath = '',
    [switch]$Apply,
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
if ($Apply -and $ValidateOnly) { throw 'choose either -Apply or -ValidateOnly' }
if (($PrincipalUserId -and $PrincipalSid) -or (-not $PrincipalUserId -and -not $PrincipalSid)) { throw 'specify exactly one of PrincipalUserId or PrincipalSid' }
function Full-Path([string]$Path) {
    if (-not $Path) { return '' }
    return [IO.Path]::GetFullPath($Path)
}

function Resolve-Sid([string]$UserId) {
    $identity = [System.Security.Principal.NTAccount]::new($UserId)
    return $identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Invoke-Icacls([string[]]$Arguments) {
    & icacls.exe @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed ($LASTEXITCODE): $($Arguments -join ' ')" }
}

function Grant-Directory([string]$Path,[string]$Sid,[string]$Rights) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "required directory missing: $Path" }
    Invoke-Icacls @($Path, '/grant:r', "*$Sid`:(OI)(CI)($Rights)")
}

function Grant-File([string]$Path,[string]$Sid,[string]$Rights) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "required file missing: $Path" }
    Invoke-Icacls @($Path, '/grant:r', "*$Sid`:($Rights)")
}

$source = Full-Path $SourceRoot
$runtime = Full-Path $RuntimeRoot
$state = Full-Path $StateRoot
$replacementState = if ($ReplacementStateRoot) { Full-Path $ReplacementStateRoot } else { Join-Path $source '.state\production-replacement' }
$oauthStore = if ($OAuthStorePath) { Full-Path $OAuthStorePath } else { Join-Path $state 'clone-a\oauth.json' }
$envFile = if ($EnvFilePath) { Full-Path $EnvFilePath } else { Join-Path $source '.env' }
$candidate = Full-Path $CandidateRoot
$edgeOwner = Full-Path $EdgeOwnerPath
$recoveryState = Full-Path $RecoveryStatePath
$gateReceipt = Full-Path $GateReceiptPath

$resolvedSid = ''
$principalResolved = $false
$principalExplicitAdmin = $null
$principalCodexSandboxMember = $null
$principalLabel = if ($PrincipalUserId) { $PrincipalUserId } else { $PrincipalSid }
try {
    $resolvedSid = if ($PrincipalSid) { [System.Security.Principal.SecurityIdentifier]::new($PrincipalSid).Value } else { Resolve-Sid $PrincipalUserId }
    $principalResolved = $true
} catch {
    if ($Apply) { throw "execution principal must resolve before ACL provisioning: $principalLabel" }
}
if ($principalResolved) {
    try {
        $adminMembers = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { $_.SID.Value })
        $principalExplicitAdmin = $resolvedSid -in $adminMembers
    } catch {
        if ($Apply) { throw "cannot verify local Administrators membership for execution principal: $principalLabel" }
    }
    try {
        $sandboxMembers = @(Get-LocalGroupMember -Group 'CodexSandboxUsers' -ErrorAction Stop | ForEach-Object { $_.SID.Value })
        $principalCodexSandboxMember = $resolvedSid -in $sandboxMembers
    } catch {
        $principalCodexSandboxMember = $false
    }
}
if ($Apply -and $principalExplicitAdmin) { throw "execution principal must not be an explicit local Administrators member: $principalLabel" }
if ($Apply -and $principalCodexSandboxMember) { throw "execution principal must not be a CodexSandboxUsers member: $principalLabel" }

$plan = @(
    [ordered]@{ path=$source; kind='directory'; rights='RX'; purpose='source/scripts read+execute' },
    [ordered]@{ path=$runtime; kind='directory'; rights='M'; purpose='replacement runtime git/dist mutation' },
    [ordered]@{ path=$state; kind='directory'; rights='M'; purpose='MCP state and shared receipts' },
    [ordered]@{ path=$replacementState; kind='directory'; rights='M'; purpose='replacement request/receipt/rollback state' },
    [ordered]@{ path=$envFile; kind='file'; rights='R'; purpose='explicit production environment file' }
)
if ($candidate) { $plan += [ordered]@{ path=$candidate; kind='directory'; rights='RX'; purpose='off-path candidate source/build' } }
if ($edgeOwner) { $plan += [ordered]@{ path=$edgeOwner; kind='file'; rights='R'; purpose='edge route renderer source' } }
if ($recoveryState) { $plan += [ordered]@{ path=$recoveryState; kind='file'; rights='R'; purpose='canonical recovery-state read' } }
if ($gateReceipt) { $plan += [ordered]@{ path=$gateReceipt; kind='file'; rights='R'; purpose='fresh production-change gate receipt read' } }

if ($Apply) {
    New-Item -ItemType Directory -Force -Path $state,$replacementState | Out-Null
    Grant-Directory $source $resolvedSid 'RX'
    Grant-Directory $runtime $resolvedSid 'M'
    Grant-Directory $state $resolvedSid 'M'
    Grant-Directory $replacementState $resolvedSid 'M'
    if (Test-Path -LiteralPath $envFile -PathType Leaf) { Grant-File $envFile $resolvedSid 'R' }
    if ($candidate) { Grant-Directory $candidate $resolvedSid 'RX' }
    if ($edgeOwner) { Grant-File $edgeOwner $resolvedSid 'R' }
    if ($recoveryState) { Grant-File $recoveryState $resolvedSid 'R' }
    if ($gateReceipt) { Grant-File $gateReceipt $resolvedSid 'R' }

    $oauthHelper = Join-Path $source 'scripts\protect-oauth-state.ps1'
    if (-not (Test-Path -LiteralPath $oauthHelper -PathType Leaf)) { throw "OAuth ACL helper missing: $oauthHelper" }
    & $oauthHelper -OAuthStorePath $oauthStore -AllowedPrincipalSid $resolvedSid | Out-Null
}

[ordered]@{
    status = if ($Apply) { 'MCP_EXECUTION_ACCESS_PROVISIONED' } else { 'MCP_EXECUTION_ACCESS_VALIDATED' }
    principal_user_id = $PrincipalUserId
    principal_sid_input = $PrincipalSid
    principal_resolved = $principalResolved
    principal_sid = $resolvedSid
    principal_explicit_local_admin = $principalExplicitAdmin
    principal_codex_sandbox_member = $principalCodexSandboxMember
    mutates_acl = [bool]$Apply
    source_root = $source
    runtime_root = $runtime
    state_root = $state
    replacement_state_root = $replacementState
    oauth_store_path = $oauthStore
    oauth_acl_owner = 'scripts/protect-oauth-state.ps1'
    codex_sandbox_users_oauth_access = 'excluded'
    access_plan = $plan
} | ConvertTo-Json -Depth 6 -Compress
