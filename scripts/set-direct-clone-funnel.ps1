param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$InstanceId,
    [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
    [Parameter(Mandatory=$true)][string]$PublicOrigin,
    [string]$Tailscale = 'C:\Program Files\Tailscale\tailscale.exe',
    [ValidateRange(1024,65535)][int]$BridgePort = 3443,
    [ValidateRange(1024,65535)][int]$FrontDoorPort = 3003,
    [string]$StateRoot = '',
    [switch]$PlanOnly,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $StateRoot) { $StateRoot = Join-Path $RepoRoot '.state' }
$originUri = [uri]$PublicOrigin
if ($originUri.Scheme -ne 'https') { throw 'PublicOrigin must use https' }
$prefix = $originUri.AbsolutePath.TrimEnd('/')
if ($prefix -notmatch '^/clone-[A-Za-z0-9._-]+$') { throw 'PublicOrigin must contain one path-scoped clone prefix such as /clone-a' }
$slug = $prefix.TrimStart('/')
if ($InstanceId -ne $slug) { throw "InstanceId '$InstanceId' must match public clone prefix '$slug'" }
$publicBase = $originUri.GetLeftPart([System.UriPartial]::Authority)
$bridgeState = Join-Path $StateRoot 'tls-bridge'
$certPath = Join-Path $bridgeState 'kone.crt'
$keyPath = Join-Path $bridgeState 'kone.key'
$routePath = Join-Path $StateRoot 'front-door\static-routes.json'
$bridgeScript = Join-Path $RepoRoot 'scripts\tls-bridge.mjs'
$tcpForward = "127.0.0.1:$BridgePort"
$publicPaths = @(
    "$prefix/health",
    "/.well-known/oauth-authorization-server/$slug",
    "/.well-known/oauth-protected-resource/$slug/mcp",
    "/.well-known/openid-configuration/$slug"
)

function Read-FunnelStatus {
    (& $Tailscale funnel status --json | ConvertFrom-Json)
}
function Bridge-Owner {
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { return [int]$listener.OwningProcess }
    return 0
}
function Ensure-Certificate {
    New-Item -ItemType Directory -Force $bridgeState | Out-Null
    if ((Test-Path -LiteralPath $certPath -PathType Leaf) -and (Test-Path -LiteralPath $keyPath -PathType Leaf)) { return }
    & $Tailscale cert --cert-file $certPath --key-file $keyPath $originUri.Host | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $certPath) -or -not (Test-Path $keyPath)) { throw 'Failed to provision TLS bridge certificate' }
}
function Ensure-Bridge {
    $owner = Bridge-Owner
    if ($owner -gt 0) { return $owner }
    Ensure-Certificate
    if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) { throw "TLS bridge script missing: $bridgeScript" }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $stdout = Join-Path $bridgeState 'bridge.stdout.log'
    $stderr = Join-Path $bridgeState 'bridge.stderr.log'
    Start-Process -FilePath $node -ArgumentList @($bridgeScript,'--cert',$certPath,'--key',$keyPath,'--listen-port',[string]$BridgePort,'--target-port',[string]$FrontDoorPort) -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do { Start-Sleep -Milliseconds 100; $owner = Bridge-Owner } while ($owner -le 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($owner -le 0) { throw 'TLS bridge did not start' }
    return $owner
}
function Read-StaticRoutePort {
    if (-not (Test-Path -LiteralPath $routePath -PathType Leaf)) { return 0 }
    $cfg = Get-Content -LiteralPath $routePath -Raw | ConvertFrom-Json
    $prop = $cfg.routes.PSObject.Properties[$slug]
    if (-not $prop) { return 0 }
    $ports = @($prop.Value)
    if ($ports.Count -lt 1) { return 0 }
    return [int]$ports[0]
}
function Set-StaticRoutePort {
    New-Item -ItemType Directory -Force (Split-Path -Parent $routePath) | Out-Null
    if (Test-Path -LiteralPath $routePath -PathType Leaf) {
        $cfg = Get-Content -LiteralPath $routePath -Raw | ConvertFrom-Json
    } else {
        $cfg = [pscustomobject]@{ version = 1; routes = [pscustomobject]@{} }
    }
    if (-not $cfg.routes) { $cfg | Add-Member -NotePropertyName routes -NotePropertyValue ([pscustomobject]@{}) -Force }
    $prop = $cfg.routes.PSObject.Properties[$slug]
    if ($prop) { $prop.Value = @($Port) }
    else { $cfg.routes | Add-Member -NotePropertyName $slug -NotePropertyValue @($Port) }
    $tmp = "$routePath.tmp-$PID"
    $cfg | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tmp -Encoding utf8
    Move-Item -LiteralPath $tmp -Destination $routePath -Force
}
function Verify-PublicPaths {
    $checks = @(
        [pscustomobject]@{ path="$prefix/health"; uri="$PublicOrigin/health" },
        [pscustomobject]@{ path="/.well-known/oauth-authorization-server/$slug"; uri="$publicBase/.well-known/oauth-authorization-server/$slug" },
        [pscustomobject]@{ path="/.well-known/oauth-protected-resource/$slug/mcp"; uri="$publicBase/.well-known/oauth-protected-resource/$slug/mcp" },
        [pscustomobject]@{ path="/.well-known/openid-configuration/$slug"; uri="$publicBase/.well-known/openid-configuration/$slug" }
    )
    foreach ($check in $checks) {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $check.uri -TimeoutSec 10
        if ([int]$response.StatusCode -ne 200) { throw "Public verification failed for $($check.path): HTTP $([int]$response.StatusCode)" }
    }
}

$plan = [pscustomobject]@{
    version = 2
    mode = 'raw_tcp_tls_bridge'
    instance_id = $InstanceId
    clone_backend_port = $Port
    front_door_port = $FrontDoorPort
    bridge_port = $BridgePort
    tcp_forward = $tcpForward
    static_route = [pscustomobject]@{ route=$slug; backend_port=$Port }
    public_paths = $publicPaths
}
if ($PlanOnly) { $plan | ConvertTo-Json -Depth 5 -Compress; exit 0 }
if (-not (Test-Path -LiteralPath $Tailscale -PathType Leaf)) { throw "Tailscale executable not found: $Tailscale" }

if (-not $VerifyOnly) {
    Set-StaticRoutePort
    $null = Ensure-Bridge
    $status = Read-FunnelStatus
    $actualForward = [string]$status.TCP.'443'.TCPForward
    if ($actualForward -ne $tcpForward) {
        # Explicit topology promotion may reset the old HTTPS handler once; the supervisor never does this automatically.
        & $Tailscale funnel reset | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Tailscale Funnel reset failed during explicit raw-TCP promotion' }
        & $Tailscale funnel --yes --bg --tcp=443 "tcp://$tcpForward" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Tailscale raw TCP Funnel promotion failed' }
    }
}

$owner = Bridge-Owner
if ($owner -le 0) { throw 'TLS bridge listener is not running' }
$actualRoute = Read-StaticRoutePort
if ($actualRoute -ne $Port) { throw "Static clone route mismatch: expected $Port got $actualRoute" }
$status = Read-FunnelStatus
$actualForward = [string]$status.TCP.'443'.TCPForward
if ($actualForward -ne $tcpForward) { throw "Raw TCP Funnel mismatch: expected '$tcpForward' got '$actualForward'" }
if ($status.TCP.'443'.HTTPS -eq $true) { throw 'HTTPS Funnel proxy mode is still active on port 443' }
Verify-PublicPaths

[pscustomobject]@{
    status='ok'
    mode='raw_tcp_tls_bridge'
    instance_id=$InstanceId
    clone_backend_port=$Port
    front_door_port=$FrontDoorPort
    bridge_port=$BridgePort
    bridge_pid=$owner
    tcp_forward=$actualForward
    public_paths=$publicPaths
} | ConvertTo-Json -Depth 5 -Compress
