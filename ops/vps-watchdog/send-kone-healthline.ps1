$ErrorActionPreference = 'Stop'

$ssh = 'C:\Program Files\Git\usr\bin\ssh.exe'
$v3 = 'C:\Users\Lauri\.local\bin\v3-rust.exe'
$hostName = if ($env:V3_WATCHDOG_SSH_HOST) { $env:V3_WATCHDOG_SSH_HOST } else { '5.61.91.127' }
$key = if ($env:V3_WATCHDOG_KONE_KEY) { $env:V3_WATCHDOG_KONE_KEY } else { Join-Path $env:LOCALAPPDATA 'V3Watchdog\kone_ed25519' }

$health = & $v3 healthline
if ($LASTEXITCODE -ne 0 -or -not $health) { throw 'existing V3 healthline read failed' }

$health | & $ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 -o StrictHostKeyChecking=yes -i $key "v3watchdog@$hostName" healthline | Out-Null
if ($LASTEXITCODE -ne 0) { throw "V3 healthline publication failed: exit=$LASTEXITCODE" }
