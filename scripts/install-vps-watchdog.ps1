param(
    [Parameter(Mandatory=$true)][string]$KonePublicKey,
    [Parameter(Mandatory=$true)][string]$OmenPublicKey,
    [string]$RepoRoot = '',
    [switch]$Execute
)
$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$bundle = Join-Path $RepoRoot 'ops\vps-watchdog'
$ssh = 'C:\Program Files\Git\usr\bin\ssh.exe'
$scp = 'C:\Program Files\Git\usr\bin\scp.exe'
$controlKey = Join-Path $env:USERPROFILE '.ssh\tietokettu_edge'
$target = 'root@5.61.91.127'

foreach ($path in @((Join-Path $bundle 'receiver.py'), (Join-Path $bundle 'status.py'), (Join-Path $bundle 'config.example.json'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing watchdog bundle file: $path" }
}

foreach ($entry in @(@{Name='KONE';Key=$KonePublicKey}, @{Name='OMEN';Key=$OmenPublicKey})) {
    if ([string]$entry.Key -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$') {
        throw "$($entry.Name) watchdog public key must be ssh-ed25519"
    }
}

$plan = [ordered]@{
    schema = 'v3-watchdog.install-plan.v1'
    target = '5.61.91.127'
    mutation_scope = @('/opt/v3-watchdog','/etc/v3-watchdog','/var/lib/v3-watchdog','/home/v3watchdog/.ssh/authorized_keys','user:v3watchdog')
    excluded = @('/etc/caddy','Caddy runtime/admin','MCP processes/routes','WireGuard','reverse tunnels','firewall','systemd services/timers')
    new_daemon = $false
    new_scanner = $false
    receiver = 'OpenSSH forced command only'
}
if (-not $Execute) {
    $plan | ConvertTo-Json -Depth 5
    exit 0
}

foreach ($path in @($ssh, $scp, $controlKey)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "registered VPS control input missing: $path" }
}

$deployId = [guid]::NewGuid().ToString('N')
$remoteStage = "/tmp/v3-watchdog-$deployId"
$authPath = Join-Path $env:TEMP "v3-watchdog-authorized-$deployId"
$authName = [IO.Path]::GetFileName($authPath)
$authorized = @(
    ('command="/opt/v3-watchdog/receiver.py KONE",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty,no-user-rc ' + $KonePublicKey.Trim()),
    ('command="/opt/v3-watchdog/receiver.py OMEN",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty,no-user-rc ' + $OmenPublicKey.Trim())
) -join [Environment]::NewLine
Set-Content -LiteralPath $authPath -Value ($authorized + [Environment]::NewLine) -Encoding utf8NoBOM

try {
    & $ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -i $controlKey $target "install -d -m 700 '$remoteStage'"
    if ($LASTEXITCODE -ne 0) { throw "VPS watchdog staging mkdir failed: exit=$LASTEXITCODE" }

    $remoteTarget = "$($target):$remoteStage/"
    & $scp -q -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -i $controlKey (Join-Path $bundle 'receiver.py') (Join-Path $bundle 'status.py') (Join-Path $bundle 'config.example.json') $authPath $remoteTarget
    if ($LASTEXITCODE -ne 0) { throw "VPS watchdog staging copy failed: exit=$LASTEXITCODE" }

    $remote = @"
set -eu
if ! id -u v3watchdog >/dev/null 2>&1; then
  useradd --create-home --home-dir /home/v3watchdog --shell /bin/sh v3watchdog
fi
install -d -o root -g root -m 0755 /opt/v3-watchdog
install -d -o root -g root -m 0755 /etc/v3-watchdog
install -d -o v3watchdog -g v3watchdog -m 0750 /var/lib/v3-watchdog
install -d -o v3watchdog -g v3watchdog -m 0700 /home/v3watchdog/.ssh
install -o root -g root -m 0755 '$remoteStage/receiver.py' /opt/v3-watchdog/receiver.py
install -o root -g root -m 0755 '$remoteStage/status.py' /opt/v3-watchdog/status.py
install -o root -g root -m 0644 '$remoteStage/config.example.json' /etc/v3-watchdog/config.json
install -o v3watchdog -g v3watchdog -m 0600 '$remoteStage/$authName' /home/v3watchdog/.ssh/authorized_keys
rm -rf '$remoteStage'
/opt/v3-watchdog/status.py
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
"@
    $result = & $ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -i $controlKey $target $remote
    if ($LASTEXITCODE -ne 0) { throw "VPS watchdog install failed: exit=$LASTEXITCODE" }
    $result
} finally {
    Remove-Item -LiteralPath $authPath -Force -ErrorAction SilentlyContinue
}
