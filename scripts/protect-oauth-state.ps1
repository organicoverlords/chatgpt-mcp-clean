param(
    [Parameter(Mandatory=$true)][string]$OAuthStorePath,
    [string]$AllowedPrincipalUserId = '',
    [string]$AllowedPrincipalSid = '',
    [switch]$VerifyOnly,
    [switch]$RequireExistingState
)
$ErrorActionPreference = 'Stop'

function Invoke-Icacls([string[]]$Arguments) {
    & icacls.exe @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed ($LASTEXITCODE): $($Arguments -join ' ')" }
}

function Sid-Value($Identity) {
    if ($Identity -is [System.Security.Principal.SecurityIdentifier]) { return $Identity.Value }
    if ($Identity -is [string]) {
        if ($Identity -match '^S-1-') { return $Identity }
        try { return ([System.Security.Principal.NTAccount]::new($Identity)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
        catch { return $Identity }
    }
    try { return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value }
    catch { return [string]$Identity }
}

function Resolve-Sid([string]$UserId) {
    if (-not $UserId) { return '' }
    $identity = [System.Security.Principal.NTAccount]::new($UserId)
    return $identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Assert-OAuthStoreContent([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "required OAuth store does not exist: $Path" }
    $raw = [IO.File]::ReadAllText($Path)
    if ([string]::IsNullOrWhiteSpace($raw)) { throw "required OAuth store is empty: $Path" }
    try { $state = $raw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "required OAuth store is not valid JSON: $Path" }
    foreach ($key in @('clients','access','refresh')) {
        if ($key -notin @($state.PSObject.Properties.Name)) { throw "required OAuth store is missing '$key': $Path" }
        if ($state.$key -isnot [pscustomobject]) { throw "required OAuth store '$key' must be an object: $Path" }
    }
    if ('codes' -in @($state.PSObject.Properties.Name) -and $state.codes -isnot [pscustomobject]) {
        throw "required OAuth store 'codes' must be an object: $Path"
    }
    $clientCount = @($state.clients.PSObject.Properties).Count
    $refreshCount = @($state.refresh.PSObject.Properties).Count
    if ($clientCount -lt 1 -or $refreshCount -lt 1) {
        throw "required OAuth store has no durable client/refresh state: $Path clients=$clientCount refresh=$refreshCount"
    }
}

$store = [IO.Path]::GetFullPath($OAuthStorePath)
$directory = Split-Path -Parent $store
if (-not $directory) { throw 'OAuth store must have a parent directory' }
if ($RequireExistingState) { Assert-OAuthStoreContent $store }

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

if (-not $VerifyOnly) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null

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
}

if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "OAuth directory does not exist: $directory" }
$directoryCheck = Get-Acl -LiteralPath $directory
if (-not $directoryCheck.AreAccessRulesProtected) { throw "OAuth directory ACL inheritance is still enabled: $directory" }
$unexpected = @($directoryCheck.Access | Where-Object { (Sid-Value $_.IdentityReference) -notin $allowedSids })
if ($unexpected.Count -gt 0) {
    throw "OAuth directory contains unexpected access principals: $($unexpected.IdentityReference.Value -join ', ')"
}
$directoryOwnerSid = Sid-Value $directoryCheck.Owner
if ($directoryOwnerSid -notin $allowedSids) { throw "OAuth directory has unexpected owner: $($directoryCheck.Owner)" }

if (Test-Path -LiteralPath $store -PathType Leaf) {
    $fileCheck = Get-Acl -LiteralPath $store
    if ($fileCheck.AreAccessRulesProtected) { throw "OAuth file must inherit from the protected private directory: $store" }
    $unexpectedFile = @($fileCheck.Access | Where-Object { (Sid-Value $_.IdentityReference) -notin $allowedSids })
    if ($unexpectedFile.Count -gt 0) {
        throw "OAuth file contains unexpected access principals: $($unexpectedFile.IdentityReference.Value -join ', ')"
    }
    $fileOwnerSid = Sid-Value $fileCheck.Owner
    if ($fileOwnerSid -notin $allowedSids) { throw "OAuth file has unexpected owner: $($fileCheck.Owner)" }
} elseif ($RequireExistingState) {
    throw "required OAuth store disappeared during verification: $store"
}

$mode = if ($VerifyOnly) { 'verify-only' } else { 'apply' }
Write-Output "OAUTH_STATE_ACL_OK mode=$mode directory=$directory allowed_principal_sid=$serviceSid"
