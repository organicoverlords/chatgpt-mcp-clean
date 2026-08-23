param([int]$Port = 0, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (Test-Path '.env') {
    foreach ($line in Get-Content -LiteralPath '.env') {
        $s = $line.Trim()
        if (-not $s -or $s.StartsWith('#') -or $s -notmatch '=') { continue }
        $name, $value = $s -split '=', 2
        Set-Item -Path "Env:$($name.Trim())" -Value $value.Trim().Trim("'").Trim('"')
    }
}
if ($Port -gt 0) { $env:PORT = [string]$Port }
if (-not $SkipBuild) { & npm.cmd run build --silent; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& node.exe dist/index.js
exit $LASTEXITCODE
