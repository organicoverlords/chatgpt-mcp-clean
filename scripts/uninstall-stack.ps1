[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpStack'),
    [string]$BusyRoot = (Join-Path $env:LOCALAPPDATA 'BusyCoordinator'),
    [string]$RulesRoot = (Join-Path $env:USERPROFILE '.agents'),
    [string]$TaskName = 'ChatGPTMcpStack',
    [string]$CaddyTaskName = 'ChatGPTMcpStackCaddy',
    [string]$RulesSyncTaskName = 'ChatGPTMcpStackRulesSync',
    [string]$FirewallRuleName = 'ChatGPT MCP Caddy HTTPS',
    [switch]$RemoveBusy,
    [switch]$RemoveRules,
    [switch]$RemoveState,
    [switch]$RemoveFirewall
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($name in @($TaskName,$CaddyTaskName,$RulesSyncTaskName)) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($task -and $PSCmdlet.ShouldProcess($name,'Unregister scheduled task')) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
}
if ($RemoveFirewall) {
    $rule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
    if ($rule -and $PSCmdlet.ShouldProcess($FirewallRuleName,'Remove firewall rule')) { $rule | Remove-NetFirewallRule }
}
if (Test-Path -LiteralPath $InstallRoot) {
    if ($RemoveState) {
        if ($PSCmdlet.ShouldProcess($InstallRoot,'Remove installed runtime, profiles, config, and state')) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }
    } else {
        foreach ($name in @('mcp','caddy','profiles','stack-config.json')) {
            $path = Join-Path $InstallRoot $name
            if (Test-Path -LiteralPath $path -and $PSCmdlet.ShouldProcess($path,'Remove installed stack component')) { Remove-Item -LiteralPath $path -Recurse -Force }
        }
    }
}
if ($RemoveBusy -and (Test-Path -LiteralPath $BusyRoot) -and $PSCmdlet.ShouldProcess($BusyRoot,'Remove BusyCoordinator installation')) { Remove-Item -LiteralPath $BusyRoot -Recurse -Force }
if ($RemoveRules -and (Test-Path -LiteralPath $RulesRoot) -and $PSCmdlet.ShouldProcess($RulesRoot,'Remove agent rules checkout')) { Remove-Item -LiteralPath $RulesRoot -Recurse -Force }
[ordered]@{ ok=$true; install_root=$InstallRoot; busy_removed=[bool]$RemoveBusy; rules_removed=[bool]$RemoveRules; state_removed=[bool]$RemoveState; firewall_removed=[bool]$RemoveFirewall } | ConvertTo-Json -Compress
