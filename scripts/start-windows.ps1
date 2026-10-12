#requires -Version 5.1
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this launcher on native Windows.' }
Get-Command node -ErrorAction Stop | Out-Null
Get-Command npm.cmd -ErrorAction Stop | Out-Null
$deckNodeMajor = & node -p "Number(process.versions.node.split('.')[0])"
if ($LASTEXITCODE -ne 0 -or [int]$deckNodeMajor -lt 24) {
    throw 'Install Node.js 24 or newer, reopen PowerShell, then run this launcher again.'
}
function Invoke-DeckNpm {
    param([string[]]$NpmArguments)
    & npm.cmd @NpmArguments
    if ($LASTEXITCODE -ne 0) { throw "npm failed: $($NpmArguments -join ' ')" }
}
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    Invoke-DeckNpm -NpmArguments @('ci')
    Invoke-DeckNpm -NpmArguments @('run', 'build')
    Write-Host 'Choose Settings > AI chat matching > Local CPU model, download Kai, test it, then enable links.'
    Invoke-DeckNpm -NpmArguments @('start')
} finally {
    Pop-Location
}
