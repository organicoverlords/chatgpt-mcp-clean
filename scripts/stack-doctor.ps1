[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpStack\stack-config.json'),
    [switch]$RequireHealthyRuntime
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name,[bool]$Ok,[string]$Detail) {
    $checks.Add([pscustomobject]@{ name=$Name; ok=$Ok; detail=$Detail }) | Out-Null
}
function Command-Exists([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

Add-Check 'config' (Test-Path -LiteralPath $ConfigPath -PathType Leaf) $ConfigPath
$config = $null
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    try { $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json; Add-Check 'config-json' $true 'valid JSON' }
    catch { Add-Check 'config-json' $false $_.Exception.Message }
}
Add-Check 'node' (Command-Exists 'node.exe') 'node.exe on PATH'
Add-Check 'python' ((Command-Exists 'python.exe') -or (Command-Exists 'python')) 'Python on PATH'
Add-Check 'git' ((Command-Exists 'git.exe') -or (Command-Exists 'git')) 'Git on PATH'
$pwshPath = 'C:\Program Files\PowerShell\7\pwsh.exe'
Add-Check 'powershell7' (Test-Path -LiteralPath $pwshPath -PathType Leaf) $pwshPath

if ($config) {
    $mcpRoot = [string]$config.mcp_root
    $busyRoot = [string]$config.busy_root
    $rulesRoot = [string]$config.rules_root
    $profile = [string]$config.plan_only_profile
    Add-Check 'mcp-dist' (Test-Path -LiteralPath (Join-Path $mcpRoot 'dist\index.js') -PathType Leaf) $mcpRoot
    $busyCmd = Join-Path $busyRoot 'busy-python.cmd'
    if (Test-Path -LiteralPath $busyCmd -PathType Leaf) {
        $contractOut = @(& $busyCmd contract 2>&1)
        Add-Check 'busy-contract' ($LASTEXITCODE -eq 0) ($contractOut -join ' ')
    } else { Add-Check 'busy-contract' $false $busyCmd }
    Add-Check 'rules' ((Test-Path -LiteralPath (Join-Path $rulesRoot 'RULES.md') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $rulesRoot 'AGENTS.md') -PathType Leaf)) $rulesRoot
    Add-Check 'topology' ([string]$config.topology -eq 'local-home-direct') ([string]$config.topology)
    Add-Check 'five-tool-profile' (([string]$config.tool_profile -eq 'process') -and ([int]$config.tool_count -eq 5)) ("profile={0} count={1}" -f $config.tool_profile,$config.tool_count)
    Add-Check 'file-transfer-tools' ([string]$config.library_delivery -eq 'explicit file tools') ([string]$config.library_delivery)
    $caddyExe = [string]$config.caddy_exe
    $caddyConfig = [string]$config.caddy_config
    Add-Check 'caddy-exe' (Test-Path -LiteralPath $caddyExe -PathType Leaf) $caddyExe
    Add-Check 'caddy-config' (Test-Path -LiteralPath $caddyConfig -PathType Leaf) $caddyConfig
    if ((Test-Path -LiteralPath $caddyExe -PathType Leaf) -and (Test-Path -LiteralPath $caddyConfig -PathType Leaf)) {
        $caddyValidation = @(& $caddyExe validate --config $caddyConfig --adapter caddyfile 2>&1)
        Add-Check 'caddy-validate' ($LASTEXITCODE -eq 0) ($caddyValidation -join ' ')
    }
    if (Test-Path -LiteralPath $profile -PathType Leaf) {
        try {
            $p = Get-Content -LiteralPath $profile -Raw | ConvertFrom-Json
            Add-Check 'plan-only-profile' ([string]$p.id -eq 'plan-only' -and $p.permissions.source_mutation -eq $false) $profile
        } catch { Add-Check 'plan-only-profile' $false $_.Exception.Message }
    } else { Add-Check 'plan-only-profile' $false $profile }

    if ([bool]$config.autostart) {
        $task = Get-ScheduledTask -TaskName ([string]$config.task_name) -ErrorAction SilentlyContinue
        Add-Check 'autostart-task' ($null -ne $task) ([string]$config.task_name)
        $caddyTask = Get-ScheduledTask -TaskName ([string]$config.caddy_task_name) -ErrorAction SilentlyContinue
        Add-Check 'caddy-autostart-task' ($null -ne $caddyTask) ([string]$config.caddy_task_name)
    }
    try {
        $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f [int]$config.port) -TimeoutSec 2
        Add-Check 'runtime-health' ($null -ne $health) ("pid={0}" -f $health.pid)
    } catch {
        Add-Check 'runtime-health' (-not $RequireHealthyRuntime) $(if ($RequireHealthyRuntime) { $_.Exception.Message } else { 'not running; allowed by current doctor mode' })
    }
}

$failed = @($checks | Where-Object { -not $_.ok })
$result = [ordered]@{ ok=($failed.Count -eq 0); config_path=$ConfigPath; checks=@($checks) }
$result | ConvertTo-Json -Depth 6
if ($failed.Count -gt 0) { exit 1 }
