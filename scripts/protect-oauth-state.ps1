param(
    [Parameter(Mandatory=$true)][string]$OAuthStorePath,
    [string]$SandboxIdentity = "$env:COMPUTERNAME\CodexSandboxUsers"
)
$ErrorActionPreference = 'Stop'

$resolvedStore = [IO.Path]::GetFullPath($OAuthStorePath)
$oauthDirectory = Split-Path -Parent $resolvedStore
if (-not $oauthDirectory) { throw 'OAuthStorePath must have a parent directory' }
New-Item -ItemType Directory -Force -Path $oauthDirectory | Out-Null

function Resolve-McpSecurityIdentifier([string]$Identity) {
    if ($Identity -match '^S-\d-(?:\d+-)+\d+$') {
        return [Security.Principal.SecurityIdentifier]::new($Identity)
    }
    try {
        return [Security.Principal.NTAccount]::new($Identity).Translate([Security.Principal.SecurityIdentifier])
    } catch [Security.Principal.IdentityNotMappedException] {
        return $null
    }
}

function Invoke-McpIcacls([string[]]$Arguments) {
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    & $icacls @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed rc=$LASTEXITCODE args=$($Arguments -join ' ')" }
}

function Test-McpAclWriteCapability([string]$Path, [Security.Principal.SecurityIdentifier]$Identity) {
    $bad = @()
    $matching = @()
    $acl = Get-Acl -LiteralPath $Path
    foreach ($rule in @($acl.Access)) {
        try { $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]) } catch { continue }
        if ($ruleSid.Value -ne $Identity.Value) { continue }
        $matching += $rule
        if (
            (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0) -or
            (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Delete) -ne 0) -or
            (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -ne 0) -or
            (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ChangePermissions) -ne 0) -or
            (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::TakeOwnership) -ne 0)
        ) { $bad += $rule }
    }
    return [pscustomobject]@{ acl = $acl; matching = $matching; bad = $bad }
}

$sandboxSid = Resolve-McpSecurityIdentifier $SandboxIdentity
if ($null -eq $sandboxSid) {
    Write-Output "OAUTH_STATE_ACL_SANDBOX_IDENTITY_ABSENT identity=$SandboxIdentity"
    exit 0
}
$principal = "*$($sandboxSid.Value)"

# Disable broad parent inheritance while copying current entries, remove every
# sandbox-group grant, then add back read/execute only. OI/CI makes every future
# oauth temp file inherit the same read-only sandbox boundary before rename.
Invoke-McpIcacls @($oauthDirectory, '/inheritance:d')
Invoke-McpIcacls @($oauthDirectory, '/remove:g', $principal)
Invoke-McpIcacls @($oauthDirectory, '/grant:r', "$principal`:(OI)(CI)(RX)")
if (Test-Path -LiteralPath $resolvedStore -PathType Leaf) {
    # Remove any stale explicit file ACL and inherit the now-protected directory DACL.
    Invoke-McpIcacls @($resolvedStore, '/reset')
}

$directoryCheck = Test-McpAclWriteCapability $oauthDirectory $sandboxSid
if (-not $directoryCheck.acl.AreAccessRulesProtected) { throw 'OAuth state directory still inherits parent ACLs' }
if ($directoryCheck.matching.Count -lt 1) { throw "OAuth state directory lost sandbox read-only ACE for $SandboxIdentity" }
if ($directoryCheck.bad.Count -gt 0) { throw "OAuth state directory still grants write-capable rights to $SandboxIdentity" }
if (Test-Path -LiteralPath $resolvedStore -PathType Leaf) {
    $storeCheck = Test-McpAclWriteCapability $resolvedStore $sandboxSid
    if ($storeCheck.matching.Count -lt 1) { throw "OAuth store lost inherited sandbox read-only ACE for $SandboxIdentity" }
    if ($storeCheck.bad.Count -gt 0) { throw "OAuth store still grants write-capable rights to $SandboxIdentity" }
}
Write-Output "OAUTH_STATE_ACL_HARDENED directory=$oauthDirectory sandbox=$($sandboxSid.Value) mode=read_execute_only"
