$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'home-direct-caddy-supervisor.ps1'
$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'config\home-direct.Caddyfile'
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$source = Get-Content -LiteralPath $scriptPath -Raw
foreach ($required in @('CanonicalConfigPath', 'MainPublicHost', 'AllowMainBackendChange', 'Assert-CaddyConfigContract', 'Get-MainBackendRoute', 'Assert-MainBackendMcpContract', 'SkipHttpErrorCheck', 'CADDY_SUPERVISOR_RETRY', 'Get-FileHash', 'Copy-Item', 'CaddyPath reload', 'while ($true)', '[switch]$Once')) {
    if ($source -notmatch [regex]::Escape($required)) { throw "missing supervisor contract: $required" }
}
$probeIndex = $source.IndexOf('Assert-MainBackendMcpContract $canonicalRoute')
$copyIndex = $source.IndexOf('Copy-Item -LiteralPath $CanonicalConfigPath')
if ($probeIndex -lt 0 -or $copyIndex -lt 0 -or $probeIndex -gt $copyIndex) { throw 'backend Host contract must be checked before config copy/reload' }
if ($source -match '\[int\]\$MainBackendPort\s*=') { throw 'supervisor must not hard-code a main backend port' }
$config = Get-Content -LiteralPath $configPath -Raw
if ($config -match '(?i)header_up|tailscale-user-login|tailscale-funnel-request') { throw 'canonical home-direct Caddy config must not inject trust headers' }

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

function Write-TestCaddyfile([string]$Path, [int]$BackendPort, [string]$Marker = '') {
    @(
        '91-159-12-133.sslip.io {',
        '    handle @local_authorize {',
        "        reverse_proxy 127.0.0.1:$BackendPort",
        '    }',
        '    handle {',
        "        reverse_proxy 127.0.0.1:$BackendPort",
        '    }',
        $(if ($Marker) { "    # $Marker" }),
        '}'
    ) | Where-Object { $null -ne $_ } | Set-Content -LiteralPath $Path -Encoding utf8
}

function Start-FakeMcpBackend([int]$BackendPort, [int]$StatusCode) {
    return Start-Job -ScriptBlock {
        param($Port, $Code)
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        try {
            $client = $listener.AcceptTcpClient()
            try {
                $stream = $client.GetStream()
                $buffer = [byte[]]::new(8192)
                $read = $stream.Read($buffer, 0, $buffer.Length)
                $request = [Text.Encoding]::ASCII.GetString($buffer, 0, $read)
                $reason = if ($Code -eq 401) { 'Unauthorized' } elseif ($Code -eq 403) { 'Forbidden' } else { 'Test' }
                $response = "HTTP/1.1 $Code $reason`r`nContent-Length: 0`r`nConnection: close`r`n`r`n"
                $bytes = [Text.Encoding]::ASCII.GetBytes($response)
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush()
                return $request
            } finally { $client.Dispose() }
        } finally { $listener.Stop() }
    } -ArgumentList $BackendPort, $StatusCode
}

function Receive-FakeMcpBackend($Job) {
    $completed = Wait-Job -Job $Job -Timeout 5
    if (-not $completed) { Stop-Job -Job $Job -ErrorAction SilentlyContinue; throw 'fake MCP backend did not receive a request' }
    try { return (@(Receive-Job -Job $Job) -join "`n") } finally { Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue }
}

function Normalize-TestOutput($Items) {
    return ((@($Items) -join "`n") -replace "`e\[[0-9;]*m", '')
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('home-direct-caddy-guard-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $oldPort = Get-FreeTcpPort
    $newPort = Get-FreeTcpPort
    $runtimeConfig = Join-Path $temp 'runtime.Caddyfile'
    $retargetConfig = Join-Path $temp 'retarget.Caddyfile'
    Write-TestCaddyfile $runtimeConfig $oldPort 'active-runtime'
    Write-TestCaddyfile $retargetConfig $newPort 'new-canonical'
    $runtimeBefore = (Get-FileHash -LiteralPath $runtimeConfig -Algorithm SHA256).Hash
    $retargetOutput = @(& pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -CanonicalConfigPath $retargetConfig -RuntimeConfigPath $runtimeConfig -CaddyPath (Join-Path $temp 'missing-caddy.exe') -Once 2>&1)
    $retargetText = Normalize-TestOutput $retargetOutput
    if ($LASTEXITCODE -eq 0) { throw 'main backend retarget without explicit switch must fail closed' }
    if ((Get-FileHash -LiteralPath $runtimeConfig -Algorithm SHA256).Hash -ne $runtimeBefore) { throw 'blocked retarget must not modify runtime config' }
    if ($retargetText -notmatch 'requires -AllowMainBackendChange') { throw "unexpected retarget-guard failure: $retargetText" }

    $backend403Port = Get-FreeTcpPort
    $badHostConfig = Join-Path $temp 'bad-host.Caddyfile'
    Write-TestCaddyfile $badHostConfig $backend403Port 'host-contract-403'
    $badHostJob = Start-FakeMcpBackend $backend403Port 403
    Start-Sleep -Milliseconds 250
    $badHostOutput = @(& pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -CanonicalConfigPath $badHostConfig -RuntimeConfigPath $runtimeConfig -CaddyPath (Join-Path $temp 'missing-caddy.exe') -AllowMainBackendChange -Once 2>&1)
    $badHostRequest = Receive-FakeMcpBackend $badHostJob
    $badHostText = Normalize-TestOutput $badHostOutput
    if ($LASTEXITCODE -eq 0) { throw 'backend Host-contract HTTP 403 must fail closed' }
    if ((Get-FileHash -LiteralPath $runtimeConfig -Algorithm SHA256).Hash -ne $runtimeBefore) { throw 'backend Host-contract failure must be rejected before runtime config copy' }
    if ($badHostText -notmatch 'must return unauthenticated HTTP' -or $badHostText -notmatch 'got 403') { throw "unexpected backend Host-contract failure: $badHostText" }
    if ($badHostRequest -notmatch '^POST /mcp HTTP/' -or $badHostRequest -notmatch '(?im)^Host:\s*91-159-12-133\.sslip\.io\s*$') { throw "backend Host-contract probe sent an unexpected request: $badHostRequest" }

    $backend401Port = Get-FreeTcpPort
    $goodHostConfig = Join-Path $temp 'good-host.Caddyfile'
    Write-TestCaddyfile $goodHostConfig $backend401Port 'host-contract-401'
    $goodHostJob = Start-FakeMcpBackend $backend401Port 401
    Start-Sleep -Milliseconds 250
    $goodHostOutput = @(& pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -CanonicalConfigPath $goodHostConfig -RuntimeConfigPath $runtimeConfig -CaddyPath (Join-Path $temp 'missing-caddy.exe') -AllowMainBackendChange -Once 2>&1)
    $goodHostRequest = Receive-FakeMcpBackend $goodHostJob
    $goodHostText = Normalize-TestOutput $goodHostOutput
    if ($LASTEXITCODE -eq 0) { throw 'good Host-contract test must reach the intentionally missing Caddy executable' }
    if ((Get-FileHash -LiteralPath $runtimeConfig -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $goodHostConfig -Algorithm SHA256).Hash) { throw 'HTTP 401 backend Host-contract plus explicit retarget switch must permit canonical config copy' }
    if ($goodHostText -notmatch 'Caddy executable is missing') { throw "good backend Host-contract did not progress to Caddy startup: $goodHostText" }
    if ($goodHostRequest -notmatch '^POST /mcp HTTP/' -or $goodHostRequest -notmatch '(?im)^Host:\s*91-159-12-133\.sslip\.io\s*$') { throw "successful backend Host-contract probe sent an unexpected request: $goodHostRequest" }

    $samePort = Get-FreeTcpPort
    $sameRuntime = Join-Path $temp 'same-runtime.Caddyfile'
    $sameCanonical = Join-Path $temp 'same-canonical.Caddyfile'
    Write-TestCaddyfile $sameRuntime $samePort 'runtime-version'
    Write-TestCaddyfile $sameCanonical $samePort 'canonical-version'
    $sameJob = Start-FakeMcpBackend $samePort 401
    Start-Sleep -Milliseconds 250
    $sameOutput = @(& pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -CanonicalConfigPath $sameCanonical -RuntimeConfigPath $sameRuntime -CaddyPath (Join-Path $temp 'missing-caddy.exe') -Once 2>&1)
    $null = Receive-FakeMcpBackend $sameJob
    $sameText = Normalize-TestOutput $sameOutput
    if ($LASTEXITCODE -eq 0) { throw 'same-route config sync test must reach the intentionally missing Caddy executable' }
    if ((Get-FileHash -LiteralPath $sameRuntime -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $sameCanonical -Algorithm SHA256).Hash) { throw 'non-route canonical config change should sync without AllowMainBackendChange' }
    if ($sameText -notmatch 'Caddy executable is missing') { throw "same-route config sync did not progress to Caddy startup: $sameText" }

    $retryStdout = Join-Path $temp 'retry.stdout.txt'
    $retryStderr = Join-Path $temp 'retry.stderr.txt'
    $retry = Start-Process -FilePath 'pwsh.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$scriptPath,'-CanonicalConfigPath',(Join-Path $temp 'missing-canonical.Caddyfile'),'-RuntimeConfigPath',(Join-Path $temp 'retry-runtime.Caddyfile'),'-PollSeconds','5') -RedirectStandardOutput $retryStdout -RedirectStandardError $retryStderr -PassThru
    Start-Sleep -Milliseconds 1200
    try {
        if ($retry.HasExited) { throw "supervisor retry loop terminated on a transient error: $(Get-Content -LiteralPath $retryStderr -Raw -ErrorAction SilentlyContinue)" }
    } finally {
        if (-not $retry.HasExited) { Stop-Process -Id $retry.Id -Force -ErrorAction SilentlyContinue; $retry.WaitForExit() }
        $retry.Dispose()
    }
} finally {
    Get-Job -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Completed' } | Stop-Job -ErrorAction SilentlyContinue
    Get-Job -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'PASS home_direct_caddy_supervisor canonical_sync=present auth_header_injection=absent retarget_guard=explicit_switch backend_host_contract=401 retry_loop=nonterminating route_port=dynamic'
