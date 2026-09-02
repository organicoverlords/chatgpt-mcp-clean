param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$InstanceId,
    [Parameter(Mandatory=$true)][ValidateRange(1024,65535)][int]$Port,
    [Parameter(Mandatory=$true)][string]$PublicOrigin,
    [string]$Tailscale = 'C:\Program Files\Tailscale\tailscale.exe',
    [switch]$PlanOnly,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'

$originUri = [uri]$PublicOrigin
if ($originUri.Scheme -ne 'https') { throw 'PublicOrigin must use https' }
$prefix = $originUri.AbsolutePath.TrimEnd('/')
if ($prefix -notmatch '^/clone-[A-Za-z0-9._-]+$') { throw 'PublicOrigin must contain one path-scoped clone prefix such as /clone-a' }
$slug = $prefix.TrimStart('/')
if ($InstanceId -ne $slug) { throw "InstanceId '$InstanceId' must match public clone prefix '$slug'" }

$routes = @(
    [pscustomobject]@{ public_path=$prefix; target="http://127.0.0.1:$Port" },
    [pscustomobject]@{ public_path="/.well-known/oauth-authorization-server/$slug"; target="http://127.0.0.1:$Port/.well-known/oauth-authorization-server/$slug" },
    [pscustomobject]@{ public_path="/.well-known/oauth-protected-resource/$slug/mcp"; target="http://127.0.0.1:$Port/.well-known/oauth-protected-resource/$slug/mcp" },
    [pscustomobject]@{ public_path="/.well-known/openid-configuration/$slug"; target="http://127.0.0.1:$Port/.well-known/openid-configuration/$slug" }
)

if ($PlanOnly) {
    [pscustomobject]@{ version=1; instance_id=$InstanceId; port=$Port; routes=$routes } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}
if (-not (Test-Path -LiteralPath $Tailscale -PathType Leaf)) { throw "Tailscale executable not found: $Tailscale" }

if (-not $VerifyOnly) {
    foreach ($route in $routes) {
        & $Tailscale funnel --yes --bg --https=443 "--set-path=$($route.public_path)" $route.target | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Tailscale Funnel update failed for $($route.public_path)" }
    }
}

$status = (& $Tailscale funnel status --json | ConvertFrom-Json)
$hostKey = $originUri.Host + ':443'
$handlers = $status.Web.$hostKey.Handlers
if (-not $handlers) { throw "No HTTPS Funnel handlers found for $hostKey" }
$errors = @()
foreach ($route in $routes) {
    $property = $handlers.PSObject.Properties[$route.public_path]
    $actual = if ($property) { [string]$property.Value.Proxy } else { '' }
    if ($actual -ne $route.target) { $errors += "$($route.public_path): expected '$($route.target)' got '$actual'" }
}
if ($errors.Count -gt 0) { throw ('Direct clone Funnel verification failed: ' + ($errors -join '; ')) }

[pscustomobject]@{
    status='ok'
    instance_id=$InstanceId
    port=$Port
    root_handler=if ($handlers.PSObject.Properties['/']) { [string]$handlers.PSObject.Properties['/'].Value.Proxy } else { $null }
    routes=$routes
} | ConvertTo-Json -Depth 4 -Compress
