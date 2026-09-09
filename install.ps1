$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\install-stack.ps1') @args
exit $LASTEXITCODE
