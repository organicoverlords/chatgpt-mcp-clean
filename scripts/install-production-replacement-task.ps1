param(
    [switch]$ExplicitUserAuthorization,
    [string]$PrincipalUserId = '',
    [ValidateSet('Interactive','S4U')][string]$PrincipalLogonType = 'Interactive',
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$root = [IO.Path]::GetFullPath($root)
$canonicalRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean'))
if (-not $ValidateOnly -and -not $root.Equals($canonicalRoot,[StringComparison]::OrdinalIgnoreCase)) {
    throw "replacement tasks must be installed from the canonical ChatGPTMcpClean root: $canonicalRoot"
}
if (-not $ValidateOnly -and -not $ExplicitUserAuthorization) { throw 'installing production replacement control tasks requires explicit user authorization' }
if (-not $PrincipalUserId) { $PrincipalUserId = "$env:USERDOMAIN\$env:USERNAME" }
$taskRoot = if ($ValidateOnly) { $root } else { $canonicalRoot }
$requestPath = Join-Path $taskRoot '.state\production-replacement\request.json'
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
$principal = New-ScheduledTaskPrincipal -UserId $PrincipalUserId -LogonType $PrincipalLogonType -RunLevel Limited
$guardianSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$candidateSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$definitions = @(
    [pscustomobject]@{Name='McpV3ProductionReplacementGuardian'; Script='production-replacement-guardian.ps1'; Settings=$guardianSettings; Description='Independent guardian for zero-gap direct-WireGuard MCP backend replacement'},
    [pscustomobject]@{Name='McpV3ProductionReplacementCandidate'; Script='production-replacement-candidate.ps1'; Settings=$candidateSettings; Description='Temporary WireGuard MCP candidate kept independent from production backend ownership'}
)
foreach ($definition in $definitions) {
    $scriptPath = Join-Path $taskRoot ("scripts\{0}" -f $definition.Script)
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "replacement control script missing: $scriptPath" }
    $arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -RequestPath `"$requestPath`""
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $taskRoot
    $task = New-ScheduledTask -Action $action -Principal $principal -Settings $definition.Settings -Description $definition.Description
    if (-not $ValidateOnly) { Register-ScheduledTask -TaskName $definition.Name -InputObject $task -Force | Out-Null }
}
if ($ValidateOnly) {
    [pscustomobject]@{
        status = 'MCP_PRODUCTION_REPLACEMENT_TASKS_VALIDATED'
        task_root = $taskRoot
        principal_user_id = $PrincipalUserId
        principal_logon_type = $PrincipalLogonType
        run_level = 'Limited'
        task_names = @($definitions.Name)
        mutates_task_scheduler = $false
    } | ConvertTo-Json -Compress
    exit 0
}
Write-Output 'MCP_PRODUCTION_REPLACEMENT_TASKS_INSTALLED'
