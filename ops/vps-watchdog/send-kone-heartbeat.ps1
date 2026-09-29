$ErrorActionPreference = 'Stop'

$ssh = 'C:\Program Files\Git\usr\bin\ssh.exe'
$hostName = if ($env:V3_WATCHDOG_SSH_HOST) { $env:V3_WATCHDOG_SSH_HOST } else { '5.61.91.127' }
$key = if ($env:V3_WATCHDOG_KONE_KEY) { $env:V3_WATCHDOG_KONE_KEY } else { Join-Path $env:LOCALAPPDATA 'V3Watchdog\kone_ed25519' }

& $ssh -T -o BatchMode=yes -o ConnectTimeout=4 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 -o StrictHostKeyChecking=yes -i $key "v3watchdog@$hostName" heartbeat | Out-Null
if ($LASTEXITCODE -ne 0) { throw "KONE watchdog heartbeat failed: exit=$LASTEXITCODE" }
