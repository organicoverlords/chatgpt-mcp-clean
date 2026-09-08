param(
    [Parameter(Mandatory=$true)][string]$OAuthStorePath
)
$ErrorActionPreference = 'Stop'

function Resolve-Principal([string]$Sid) {
    return ([System.Security.Principal.SecurityIdentifier]::new($Sid)).Translate([System.Security.Principal.NTAccount])
}

function Reset-ExplicitAcl([System.Security.AccessControl.ObjectSecurity]$Acl) {
    $Acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($Acl.Access | Where-Object { -not $_.IsInherited })) {
        [void]$Acl.RemoveAccessRuleSpecific($rule)
    }
}

$store = [IO.Path]::GetFullPath($OAuthStorePath)
$directory = Split-Path -Parent $store
if (-not $directory) { throw 'OAuth store must have a parent directory' }
New-Item -ItemType Directory -Force -Path $directory | Out-Null

$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$system = (Resolve-Principal 'S-1-5-18').Value
$admins = (Resolve-Principal 'S-1-5-32-544').Value

$directoryAcl = Get-Acl -LiteralPath $directory
Reset-ExplicitAcl $directoryAcl
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
foreach ($principal in @($current, $system, $admins)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $principal,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        $propagation,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$directoryAcl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $directory -AclObject $directoryAcl

if (Test-Path -LiteralPath $store -PathType Leaf) {
    $fileAcl = Get-Acl -LiteralPath $store
    Reset-ExplicitAcl $fileAcl
    foreach ($principal in @($current, $system, $admins)) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $principal,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void]$fileAcl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $store -AclObject $fileAcl
}

$directoryCheck = Get-Acl -LiteralPath $directory
if (-not $directoryCheck.AreAccessRulesProtected) { throw "OAuth directory ACL inheritance is still enabled: $directory" }
$unexpected = @($directoryCheck.Access | Where-Object {
    $_.IdentityReference.Value -notin @($current, $system, $admins)
})
if ($unexpected.Count -gt 0) {
    throw "OAuth directory contains unexpected access principals: $($unexpected.IdentityReference.Value -join ', ')"
}

if (Test-Path -LiteralPath $store -PathType Leaf) {
    $fileCheck = Get-Acl -LiteralPath $store
    if (-not $fileCheck.AreAccessRulesProtected) { throw "OAuth file ACL inheritance is still enabled: $store" }
    $unexpectedFile = @($fileCheck.Access | Where-Object {
        $_.IdentityReference.Value -notin @($current, $system, $admins)
    })
    if ($unexpectedFile.Count -gt 0) {
        throw "OAuth file contains unexpected access principals: $($unexpectedFile.IdentityReference.Value -join ', ')"
    }
}

Write-Output "OAUTH_STATE_ACL_OK directory=$directory"
