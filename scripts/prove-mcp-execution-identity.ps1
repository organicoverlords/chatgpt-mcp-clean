param(
    [Parameter(Mandatory=$true)][string]$PrincipalUserId,
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$ProofRoot,
    [switch]$ExecuteProof,
    [switch]$ValidateOnly,
    [ValidateRange(30,600)][int]$TimeoutSec = 180
)
$ErrorActionPreference = 'Stop'
if ($ExecuteProof -and $ValidateOnly) { throw 'choose either -ExecuteProof or -ValidateOnly' }
$source = [IO.Path]::GetFullPath($SourceRoot)
$proof = [IO.Path]::GetFullPath($ProofRoot)
$allowed = Join-Path $proof 'allowed-state'
$runtime = Join-Path $proof 'runtime'
$denied = Join-Path $proof 'host-only'
$receiptPath = Join-Path $allowed 'identity-proof-receipt.json'
$probeScript = Join-Path $source 'scripts\\mcp-execution-identity-probe.ps1'
$accessHelper = Join-Path $source 'scripts\\provision-mcp-execution-access.ps1'
$taskName = "McpIdentityProof-$([guid]::NewGuid().ToString('N').Substring(0,12))"
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source

function Resolve-Sid([string]$UserId) {
    $account = [Security.Principal.NTAccount]::new($UserId)
    return $account.Translate([Security.Principal.SecurityIdentifier]).Value
}

$targetSid = ''
$principalResolved = $false
$principalEnabled = $null
$principalAdmin = $null
$principalSandbox = $null
try {
    $targetSid = Resolve-Sid $PrincipalUserId
    $principalResolved = $true
    $local = Get-LocalUser -SID $targetSid -ErrorAction SilentlyContinue
    if ($local) { $principalEnabled = [bool]$local.Enabled }
    $adminSids = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { $_.SID.Value })
    $principalAdmin = $targetSid -in $adminSids
    $sandboxSids = @(Get-LocalGroupMember -Group 'CodexSandboxUsers' -ErrorAction SilentlyContinue | ForEach-Object { $_.SID.Value })
    $principalSandbox = $targetSid -in $sandboxSids
} catch {
    if ($ExecuteProof) { throw "dedicated proof principal must already exist and resolve: $PrincipalUserId" }
}

$plan = [ordered]@{
    status = if ($ExecuteProof) { 'MCP_EXECUTION_IDENTITY_PROOF_REQUESTED' } else { 'MCP_EXECUTION_IDENTITY_PROOF_VALIDATED' }
    principal_user_id = $PrincipalUserId
    principal_resolved = $principalResolved
    principal_sid = $targetSid
    principal_enabled = $principalEnabled
    principal_explicit_local_admin = $principalAdmin
    principal_codex_sandbox_member = $principalSandbox
    principal_is_current_user = [bool]($targetSid -and $targetSid -eq $currentSid)
    task_logon_type = 'S4U'
    task_run_level = 'Limited'
    network_model = 'S4U_LOCAL_ONLY_NO_NETWORK_CREDENTIALS'
    network_dependent_orchestration = 'REPLACEMENT_GUARDIAN_HOST_CONTROL_IDENTITY'
    source_root = $source
    proof_root = $proof
    allowed_state_root = $allowed
    denied_root = $denied
    receipt_path = $receiptPath
    process_tool_compatibility_probe = 'scripts/test-minimal-clones.mjs'
    node_exe_path = $nodeExe
    disposable_task_prefix = 'McpIdentityProof-'
    mutates_task_scheduler = [bool]$ExecuteProof
    touches_production_tasks = $false
}
if (-not $ExecuteProof) { $plan | ConvertTo-Json -Depth 6 -Compress; exit 0 }

if (-not $principalResolved) { throw 'dedicated proof principal did not resolve' }
if ($principalEnabled -eq $false) { throw 'dedicated proof principal is disabled' }
if ($targetSid -eq $currentSid) { throw 'off-path proof principal must differ from the current host user' }
if ($principalAdmin) { throw 'off-path proof principal must not be an explicit local Administrators member' }
if ($principalSandbox) { throw 'off-path proof principal must not be a CodexSandboxUsers member' }
if (-not (Test-Path -LiteralPath $probeScript -PathType Leaf)) { throw "identity probe missing: $probeScript" }
if (-not (Test-Path -LiteralPath $accessHelper -PathType Leaf)) { throw "execution access helper missing: $accessHelper" }
if (-not (Test-Path -LiteralPath (Join-Path $source 'scripts\\test-minimal-clones.mjs') -PathType Leaf)) { throw 'MCP process-profile compatibility probe is missing' }

New-Item -ItemType Directory -Force -Path $proof,$allowed,$runtime,$denied | Out-Null
$operatorSid = $currentSid
& icacls.exe $denied '/inheritance:r' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'failed to protect denied proof root' }
& icacls.exe $denied '/grant:r' "*$operatorSid`:(OI)(CI)(F)" '*S-1-5-18:(OI)(CI)(F)' '*S-1-5-32-544:(OI)(CI)(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'failed to assign denied proof root ACL' }
Set-Content -LiteralPath (Join-Path $denied 'host-only.txt') -Value 'operator-only-proof-state' -Encoding UTF8

& $accessHelper -PrincipalUserId $PrincipalUserId -SourceRoot $source -RuntimeRoot $runtime -StateRoot $allowed -ReplacementStateRoot (Join-Path $allowed 'replacement') -OAuthStorePath (Join-Path $allowed 'oauth\\oauth.json') -Apply | Out-Null

$pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$probeScript`" -ReceiptPath `"$receiptPath`" -AllowedStateRoot `"$allowed`" -DeniedRoot `"$denied`" -SourceRoot `"$source`" -NodeExePath `"$nodeExe`""
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $source
$principal = New-ScheduledTaskPrincipal -UserId $PrincipalUserId -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description 'Disposable off-path MCP dedicated execution identity proof'
try {
    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
    $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ([string]$registered.Principal.LogonType -notmatch 'S4U') { throw 'proof task did not register with S4U logon type' }
    if ([string]$registered.Principal.RunLevel -notmatch 'Limited') { throw 'proof task did not register at Limited run level' }
    Start-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
    do {
        if (Test-Path -LiteralPath $receiptPath -PathType Leaf) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { throw "identity proof receipt was not produced within ${TimeoutSec}s" }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ([string]$receipt.schema -ne 'mcp-execution-identity-proof.v1') { throw 'identity proof receipt schema mismatch' }
    if ([string]$receipt.principal_sid -ne $targetSid) { throw "identity proof ran under the wrong SID: $($receipt.principal_sid)" }
    if ([bool]$receipt.is_administrator) { throw 'identity proof token is administrative' }
    if (-not [bool]$receipt.allowed_write -or -not [bool]$receipt.allowed_read) { throw 'dedicated identity could not use the explicitly allowed MCP state path' }
    if (-not [bool]$receipt.denied_read -or -not [bool]$receipt.denied_write) { throw 'dedicated identity accessed representative host-only state' }
    if ([int]$receipt.process_profile_smoke_exit_code -ne 0 -or -not [bool]$receipt.process_profile_smoke_pass -or -not [bool]$receipt.process_profile_tools_exact -or -not [bool]$receipt.process_profile_state_root_explicit) { throw 'MCP process-profile compatibility smoke failed under the dedicated identity' }
    $plan.status = 'MCP_EXECUTION_IDENTITY_PROOF_PASS'
    $plan['receipt'] = $receipt
    $plan | ConvertTo-Json -Depth 8 -Compress
} finally {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
}
