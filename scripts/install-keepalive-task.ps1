# Registers the shell-mcp supervisor as a logon Scheduled Task.
#
# Without this the supervisor is only ever a plain hidden PowerShell process: it dies
# with whatever shell launched it and never starts at logon, so nothing restarts the
# restarter. This task is the top of the chain.
#
# Deliberately NOT elevated. The server binds 127.0.0.1:3000 and needs no admin, and an
# elevated listener reports a blank CommandLine to a non-elevated WMI query, which is
# what previously made keepalive.ps1 misclassify its own server as foreign and refuse to
# reclaim the port.
#
# Re-runnable: an existing task with this name is replaced.

param(
    [string]$TaskName = 'ShellMcpKeepAlive',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Script = Join-Path $Root 'keepalive.ps1'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "removed scheduled task '$TaskName'"
    } else {
        Write-Output "no scheduled task '$TaskName' to remove"
    }
    return
}

if (-not (Test-Path $Script)) { throw "supervisor not found: $Script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $Script) `
    -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Run as the logged-on user, non-elevated, no stored password.
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

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Keeps the shell-mcp server (127.0.0.1:3000) running and its Tailscale Funnel configured.' | Out-Null

Write-Output "registered scheduled task '$TaskName'"
Write-Output "  runs: powershell.exe -File $Script"
Write-Output "  as:   $env:USERDOMAIN\$env:USERNAME (Limited, interactive logon)"
Write-Output "  when: at logon, restarts up to 3x at 1-minute intervals, no time limit"
