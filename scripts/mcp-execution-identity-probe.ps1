param(
    [Parameter(Mandatory=$true)][string]$ReceiptPath,
    [Parameter(Mandatory=$true)][string]$AllowedStateRoot,
    [Parameter(Mandatory=$true)][string]$DeniedRoot,
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$NodeExePath
)
$ErrorActionPreference = 'Stop'
$receipt = [ordered]@{
    schema = 'mcp-execution-identity-proof.v1'
    recorded_at = (Get-Date).ToUniversalTime().ToString('o')
    principal_name = ''
    principal_sid = ''
    is_administrator = $null
    allowed_write = $false
    allowed_read = $false
    denied_read = $false
    denied_write = $false
    process_profile_smoke_exit_code = $null
    process_profile_smoke_pass = $false
    process_profile_tools_exact = $false
    process_profile_state_root_explicit = $false
    error = ''
}
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $receipt.principal_name = $identity.Name
    $receipt.principal_sid = $identity.User.Value
    $receipt.is_administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    $allowedFile = Join-Path $AllowedStateRoot ("identity-proof-{0}.txt" -f $PID)
    [IO.File]::WriteAllText($allowedFile, 'mcp-identity-proof')
    $receipt.allowed_write = Test-Path -LiteralPath $allowedFile -PathType Leaf
    $receipt.allowed_read = ([IO.File]::ReadAllText($allowedFile) -eq 'mcp-identity-proof')
    Remove-Item -LiteralPath $allowedFile -Force

    $deniedSentinel = Join-Path $DeniedRoot 'host-only.txt'
    try { [void][IO.File]::ReadAllText($deniedSentinel); $receipt.denied_read = $false } catch { $receipt.denied_read = $true }
    try { [IO.File]::WriteAllText((Join-Path $DeniedRoot 'must-not-write.txt'), 'blocked'); $receipt.denied_write = $false } catch { $receipt.denied_write = $true }

    if (-not (Test-Path -LiteralPath $NodeExePath -PathType Leaf)) { throw "node executable missing: $NodeExePath" }
    $smokeScript = Join-Path $SourceRoot 'scripts\\test-minimal-clones.mjs'
    if (-not (Test-Path -LiteralPath $smokeScript -PathType Leaf)) { throw "process-profile smoke probe missing: $smokeScript" }
    $smokeState = Join-Path $AllowedStateRoot 'process-profile-smoke'
    New-Item -ItemType Directory -Force -Path $smokeState | Out-Null
    $previousSmokeState = $env:MCP_TEST_STATE_ROOT
    try {
        $env:MCP_TEST_STATE_ROOT = $smokeState
        $smokeOutput = @(& $NodeExePath $smokeScript 2>&1 | ForEach-Object { [string]$_ })
        $receipt.process_profile_smoke_exit_code = $LASTEXITCODE
        $jsonLine = @($smokeOutput | Where-Object { $_.TrimStart().StartsWith('{') }) | Select-Object -Last 1
        if ($LASTEXITCODE -eq 0 -and $jsonLine) {
            $smokeResult = $jsonLine | ConvertFrom-Json
            $receipt.process_profile_smoke_pass = ([string]$smokeResult.result -eq 'PASS')
            $receipt.process_profile_tools_exact = ((@($smokeResult.tools) -join ',') -eq 'kill_process,read_output,start_process')
            $receipt.process_profile_state_root_explicit = ([string]$smokeResult.state_root_mode -eq 'explicit')
        }
    } finally {
        if ($null -eq $previousSmokeState) { Remove-Item Env:MCP_TEST_STATE_ROOT -ErrorAction SilentlyContinue } else { $env:MCP_TEST_STATE_ROOT = $previousSmokeState }
    }
} catch {
    $receipt.error = $_.Exception.Message
} finally {
    $directory = Split-Path -Parent $ReceiptPath
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8
}
if ($receipt.error -or -not $receipt.allowed_write -or -not $receipt.allowed_read -or -not $receipt.denied_read -or -not $receipt.denied_write -or $receipt.is_administrator -or -not $receipt.process_profile_smoke_pass -or -not $receipt.process_profile_tools_exact -or -not $receipt.process_profile_state_root_explicit) { exit 1 }
exit 0
