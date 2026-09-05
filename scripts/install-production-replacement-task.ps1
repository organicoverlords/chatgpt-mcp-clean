param(
    [switch]$ExplicitUserAuthorization
)
$ErrorActionPreference = 'Stop'
if (-not $ExplicitUserAuthorization) { throw 'installing production replacement control tasks requires explicit user authorization' }
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$canonicalRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean'))
if (-not ([IO.Path]::GetFullPath($root)).Equals($canonicalRoot,[StringComparison]::OrdinalIgnoreCase)) {
    throw "replacement tasks must be installed from the canonical ChatGPTMcpClean root: $canonicalRoot"
}
$requestPath = Join-Path $canonicalRoot '.state\production-replacement\request.json'
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$guardianSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$candidateSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$definitions = @(
    [pscustomobject]@{Name='McpV3ProductionReplacementGuardian'; Script='production-replacement-guardian.ps1'; Settings=$guardianSettings; Description='Independent guardian for zero-gap direct-WireGuard MCP backend replacement'},
    [pscustomobject]@{Name='McpV3ProductionReplacementCandidate'; Script='production-replacement-candidate.ps1'; Settings=$candidateSettings; Description='Temporary WireGuard MCP candidate kept independent from production backend ownership'}
)
foreach ($definition in $definitions) {
    $scriptPath = Join-Path $canonicalRoot ("scripts\{0}" -f $definition.Script)
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "replacement control script missing: $scriptPath" }
    $arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -RequestPath `"$requestPath`""
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $canonicalRoot
    $task = New-ScheduledTask -Action $action -Principal $principal -Settings $definition.Settings -Description $definition.Description
    Register-ScheduledTask -TaskName $definition.Name -InputObject $task -Force | Out-Null
}
Write-Output 'MCP_PRODUCTION_REPLACEMENT_TASKS_INSTALLED'
