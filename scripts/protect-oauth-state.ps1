param(
    [Parameter(Mandatory=$true)][string]$OAuthStorePath,
    [string]$AllowedPrincipalUserId = '',
    [string]$AllowedPrincipalSid = ''
)
$ErrorActionPreference = 'Stop'

function Invoke-Icacls([string[]]$Arguments) {
    & icacls.exe @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed ($LASTEXITCODE): $($Arguments -join ' ')" }
}

function Sid-Value([System.Security.Principal.IdentityReference]$Identity) {
    if ($Identity -is [System.Security.Principal.SecurityIdentifier]) { return $Identity.Value }
    try { return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value }
    catch { return $Identity.Value }
}

function Resolve-Sid([string]$UserId) {
    if (-not $UserId) { return '' }
    $identity = [System.Security.Principal.NTAccount]::new($UserId)
    return $identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
}

$store = [IO.Path]::GetFullPath($OAuthStorePath)
$directory = Split-Path -Parent $store
if (-not $directory) { throw 'OAuth store must have a parent directory' }
New-Item -ItemType Directory -Force -Path $directory | Out-Null

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($AllowedPrincipalUserId -and $AllowedPrincipalSid) { throw 'choose either AllowedPrincipalUserId or AllowedPrincipalSid' }
$serviceSid = if ($AllowedPrincipalSid) { [System.Security.Principal.SecurityIdentifier]::new($AllowedPrincipalSid).Value } elseif ($AllowedPrincipalUserId) { Resolve-Sid $AllowedPrincipalUserId } else { '' }
$sandboxSid = ''
$sandboxMemberSids = @()
try { $sandboxSid = Resolve-Sid ("$env:COMPUTERNAME\CodexSandboxUsers") } catch { }
try { $sandboxMemberSids = @(Get-LocalGroupMember -Group 'CodexSandboxUsers' -ErrorAction Stop | ForEach-Object { $_.SID.Value }) } catch { }
if ($serviceSid -and (($sandboxSid -and $serviceSid -eq $sandboxSid) -or $serviceSid -in $sandboxMemberSids)) { throw 'CodexSandboxUsers cannot be an allowed MCP execution principal' }
$allowedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
if ($serviceSid -and $serviceSid -notin $allowedSids) { $allowedSids += $serviceSid }

# Change only the DACL. Set-Acl on an existing directory can carry its SACL/audit
# section back to Windows and require SeSecurityPrivilege, which the normal-integrity
# replacement candidate intentionally does not have.
Invoke-Icacls @($directory, '/inheritance:r')

# Remove any unexpected explicit DACL principals left after inherited entries are removed.
$directoryAcl = Get-Acl -LiteralPath $directory
$unexpectedSids = @($directoryAcl.Access | ForEach-Object { Sid-Value $_.IdentityReference } | Where-Object { $_ -notin $allowedSids } | Sort-Object -Unique)
foreach ($sid in $unexpectedSids) {
    $principal = if ($sid -match '^S-1-') { "*$sid" } else { $sid }
    Invoke-Icacls @($directory, '/remove:g', $principal)
    Invoke-Icacls @($directory, '/remove:d', $principal)
}

$grants = @(
    "*$currentSid`:(OI)(CI)(F)",
    '*S-1-5-18:(OI)(CI)(F)',
    '*S-1-5-32-544:(OI)(CI)(F)'
)
if ($serviceSid -and $serviceSid -notin @($currentSid, 'S-1-5-18', 'S-1-5-32-544')) {
    $grants += "*$serviceSid`:(OI)(CI)(M)"
}
Invoke-Icacls (@($directory, '/grant:r') + $grants)

# The protected directory is the durable boundary. Let the current OAuth file inherit
# from it, matching the temp-file + atomic-rename persistence path used by the provider.
if (Test-Path -LiteralPath $store -PathType Leaf) {
    Invoke-Icacls @($store, '/inheritance:e')
    Invoke-Icacls @($store, '/reset')
}

$directoryCheck = Get-Acl -LiteralPath $directory
if (-not $directoryCheck.AreAccessRulesProtected) { throw "OAuth directory ACL inheritance is still enabled: $directory" }
$unexpected = @($directoryCheck.Access | Where-Object { (Sid-Value $_.IdentityReference) -notin $allowedSids })
if ($unexpected.Count -gt 0) {
    throw "OAuth directory contains unexpected access principals: $($unexpected.IdentityReference.Value -join ', ')"
}

if (Test-Path -LiteralPath $store -PathType Leaf) {
    $fileCheck = Get-Acl -LiteralPath $store
    if ($fileCheck.AreAccessRulesProtected) { throw "OAuth file must inherit from the protected private directory: $store" }
    $unexpectedFile = @($fileCheck.Access | Where-Object { (Sid-Value $_.IdentityReference) -notin $allowedSids })
    if ($unexpectedFile.Count -gt 0) {
        throw "OAuth file contains unexpected access principals: $($unexpectedFile.IdentityReference.Value -join ', ')"
    }
}

Write-Output "OAUTH_STATE_ACL_OK directory=$directory allowed_principal_sid=$serviceSid"
