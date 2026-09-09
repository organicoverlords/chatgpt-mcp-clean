param(
    [ValidateRange(1024,65535)][int]$Port = 3011,
    [ValidatePattern('^[A-Za-z0-9._-]+$')][string]$InstanceId = 'clone-a',
    [string]$PublicOrigin = 'https://5-61-91-127.sslip.io',
    [string]$StateRoot = '',
    [string]$SharedReceiptDirectory = '',
    [string]$OAuthStorePath = '',
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Root = [IO.Path]::GetFullPath($Root)
if (-not $StateRoot) { $StateRoot = Join-Path $Root 'minimal-connectors' }
$StateRoot = [IO.Path]::GetFullPath($StateRoot)
$stateParent = Split-Path -Parent $StateRoot
if (-not $SharedReceiptDirectory) { $SharedReceiptDirectory = Join-Path $StateRoot 'shared-process-receipts' }
if (-not $OAuthStorePath) { $OAuthStorePath = Join-Path (Join-Path $StateRoot $InstanceId) 'oauth.json' }

$listener = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object { $_.Address.Equals([Net.IPAddress]::Loopback) -and $_.Port -eq $Port } |
    Select-Object -First 1
if ($listener) {
    try {
        $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -Method Get -TimeoutSec 2
        if ($health.status -eq 'ok' -and $health.name -eq 'shell-mcp' -and $health.role -eq 'backend' -and [int]$health.port -eq $Port) {
            Write-Output ("MCP_PRODUCTION_ALREADY_HEALTHY pid={0} generation={1}" -f $health.pid, $health.backend_generation)
            exit 0
        }
    } catch {
        # An occupied target port cannot be recovered by starting another listener on the same port.
    }
    Write-Error ("MCP_PRODUCTION_PORT_OCCUPIED_UNHEALTHY port={0}: refusing duplicate bind; preserve the current listener and let the existing recovery policy retry." -f $Port)
    exit 1
}

$envFile = Join-Path $stateParent '.env'
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        $s = $line.Trim()
        if (!$s -or $s.StartsWith('#') -or $s -notmatch '=') { continue }
        $name, $value = $s -split '=', 2
        Set-Item -Path "Env:$($name.Trim())" -Value $value.Trim().Trim("'").Trim('"')
    }
}

& "$Root\scripts\start-minimal-clone.ps1" `
    -InstanceId $InstanceId `
    -Port $Port `
    -PublicOrigin $PublicOrigin `
    -StateRoot $StateRoot `
    -OAuthStorePath $OAuthStorePath `
    -SharedReceiptDirectory $SharedReceiptDirectory `
    -SkipBuild:$SkipBuild
exit $LASTEXITCODE
