$ErrorActionPreference = 'Stop'
$created = $false
$mutex = New-Object System.Threading.Mutex($false, 'Local\McpV4HomeDirect3022', [ref]$created)
$held = $false
try {
    $held = $mutex.WaitOne(0)
    if (-not $held) { exit 0 }
    $runtimeRoot = Split-Path -Parent $PSScriptRoot
    $env:MCP_OWNER_AUTH_ORIGIN = 'https://kone.tailbf0440.ts.net'
    & (Join-Path $runtimeRoot 'scripts\start-minimal-clone.ps1') `
        -InstanceId 'home-direct-test' `
        -Port 3022 `
        -PublicOrigin 'https://91-159-12-133.sslip.io' `
        -StateRoot (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors') `
        -OAuthStorePath (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors\home-direct-test\oauth.json') `
        -SharedReceiptDirectory (Join-Path $env:LOCALAPPDATA 'ChatGPTMcpClean\minimal-connectors\shared-process-receipts') `
        -SkipBuild `
        -SkipNativeRuntimePriority `
        -RestartOnUnexpectedExit `
        -RestartBackoffSeconds 2 `
        -RestartLimit 0
    exit $LASTEXITCODE
} finally {
    if ($held) { try { $mutex.ReleaseMutex() } catch {} }
    $mutex.Dispose()
}
