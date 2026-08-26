# Registers independent supervisors for the stable front door and two backend slots.
# Re-running updates task definitions in place. It does not stop running tasks or listeners.
param(
    [string]$FrontDoorTaskName = 'ShellMcpKeepAlive',
    [string]$BlueTaskName = 'ShellMcpBackend3001',
    [string]$GreenTaskName = 'ShellMcpBackend3002',
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Script = Join-Path $Root 'keepalive.ps1'
$taskNames = @($FrontDoorTaskName,$BlueTaskName,$GreenTaskName)

if ($Uninstall) {
    foreach ($taskName in $taskNames) {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-Output "removed scheduled task '$taskName'"
        }
    }
    return
}
if (-not (Test-Path $Script)) { throw "supervisor not found: $Script" }

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$definitions = @(
    @{ Name=$FrontDoorTaskName; Arguments='-Role FrontDoor -Port 3003'; Description='Keeps the stable shell-mcp front door on 127.0.0.1:3003 alive and preserves the Tailscale Funnel target.' },
    @{ Name=$BlueTaskName; Arguments='-Role Backend -Port 3001'; Description='Keeps the blue replaceable shell-mcp backend on 127.0.0.1:3001 alive.' },
    @{ Name=$GreenTaskName; Arguments='-Role Backend -Port 3002'; Description='Keeps the green replaceable shell-mcp backend on 127.0.0.1:3002 alive.' }
)
foreach ($definition in $definitions) {
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" {1}' -f $Script,$definition.Arguments
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $Root
    Register-ScheduledTask -TaskName $definition.Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $definition.Description -Force | Out-Null
    Write-Output "registered scheduled task '$($definition.Name)' ($($definition.Arguments))"
}
Write-Output 'task definitions updated; no running task or listener was stopped or started'
