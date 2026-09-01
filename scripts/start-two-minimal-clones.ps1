param(
    [string]$ConfigPath = (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'config\minimal-clones.example.json'),
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors'),
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$instances = @($config.instances)
if ($instances.Count -ne 2) { throw 'The initial #125 rollout requires exactly two connector instances.' }
if (-not $SkipBuild) { & npm.cmd run build --silent; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
$sharedReceipts = Join-Path $StateRoot 'shared-process-receipts'
New-Item -ItemType Directory -Force -Path $StateRoot,$sharedReceipts | Out-Null
$started = @()
foreach ($instance in $instances) {
    $id = [string]$instance.id
    $port = [int]$instance.port
    $origin = [string]$instance.public_origin
    $logs = Join-Path $StateRoot $id
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $stdout = Join-Path $logs 'launcher.stdout.log'
    $stderr = Join-Path $logs 'launcher.stderr.log'
    $args = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'scripts\start-minimal-clone.ps1'),'-InstanceId',$id,'-Port',[string]$port,'-PublicOrigin',$origin,'-StateRoot',$StateRoot,'-SharedReceiptDirectory',$sharedReceipts,'-SkipBuild')
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $started += [pscustomobject]@{ id=$id; port=$port; public_origin=$origin; launcher_pid=$process.Id; stdout=$stdout; stderr=$stderr }
}
$started | ConvertTo-Json -Depth 3 -Compress
