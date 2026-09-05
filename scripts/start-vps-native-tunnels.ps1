$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'McpVpsEdge'
$ssh = 'C:\Program Files\Git\usr\bin\ssh.exe'
$key = Join-Path $env:USERPROFILE '.ssh\tietokettu_edge'
$hostName = 'root@5.61.91.127'
$remotePorts = @(3101, 3102, 3103, 3104)

if (!(Test-Path -LiteralPath $ssh)) {
  throw "MCP_VPS_NATIVE_SSH_MISSING path=$ssh"
}
if (!(Test-Path -LiteralPath $key)) {
  throw "MCP_VPS_SSH_KEY_MISSING path=$key"
}

# Four independent native OpenSSH connections replace the retired single Python tunnel.
# A failure in one lane must not block or restart the other three lanes.
$existing = @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue)
$started = 0
$healthy = 0
foreach ($remotePort in $remotePorts) {
  $needle = "127.0.0.1:${remotePort}:127.0.0.1:3011"
  $lane = $existing | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($needle) -and $_.CommandLine.Contains($hostName)
  } | Select-Object -First 1

  if ($lane) {
    Write-Output ("MCP_VPS_NATIVE_TUNNEL_PRESENT port={0} pid={1}" -f $remotePort, $lane.ProcessId)
    $healthy++
    continue
  }

  $sshArgs = @(
    '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'ConnectTimeout=5',
    '-i', $key,
    '-R', $needle,
    $hostName
  )
  $proc = Start-Process -FilePath $ssh -ArgumentList $sshArgs -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 150
  if ($proc.HasExited) {
    throw ("MCP_VPS_NATIVE_TUNNEL_START_FAILED port={0} exit={1}" -f $remotePort, $proc.ExitCode)
  }
  Write-Output ("MCP_VPS_NATIVE_TUNNEL_STARTED port={0} pid={1}" -f $remotePort, $proc.Id)
  $started++
  $healthy++
}

if ($healthy -ne $remotePorts.Count) {
  throw ("MCP_VPS_NATIVE_TUNNEL_INCOMPLETE healthy={0} expected={1}" -f $healthy, $remotePorts.Count)
}
Write-Output ("MCP_VPS_NATIVE_TUNNELS_OK lanes={0} started={1}" -f $healthy, $started)
exit 0