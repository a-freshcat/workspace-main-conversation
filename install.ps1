# Install the workspace-main-conversation skill for DeepSeek Harness.
#
# Usage:
#   .\install.ps1              # install to ~/.dsh/skills/
#   .\install.ps1 -Force       # overwrite if already present
#
# This script is pure ASCII on purpose: Windows PowerShell 5.1 reads .ps1
# as ANSI, so non-ASCII text without a BOM would be garbled. Keeping it ASCII
# makes it work identically on PowerShell 5.1, PowerShell 7, and cross-platform.
#
# It only copies files. It never deletes anything.

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$dest = Join-Path $dshHome 'skills\workspace-main-conversation'

Write-Host ""
Write-Host "=== Installing workspace-main-conversation ===" -ForegroundColor Cyan
Write-Host "  Source : $src"
Write-Host "  Target : $dest"
Write-Host ""

$required = @('SKILL.md', 'check.mjs', 'audit-owners.mjs', 'selftest-portable.mjs', 'zstd-frames.mjs')
$missing = @()
foreach ($f in $required) {
    if (-not (Test-Path (Join-Path $src $f))) { $missing += $f }
}
if ($missing.Count -gt 0) {
    Write-Host "  [X] Missing source files:" -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "      - $m" -ForegroundColor Red }
    exit 1
}
Write-Host "  [OK] All $($required.Count) source files present" -ForegroundColor Green

if (Test-Path $dest) {
    if (-not $Force) {
        Write-Host ""
        Write-Host "  [!] Target already exists: $dest" -ForegroundColor Yellow
        Write-Host "      Re-run with -Force to overwrite" -ForegroundColor Yellow
        exit 2
    }
    Write-Host "  [!] Target exists, overwriting (-Force)" -ForegroundColor Yellow
}

New-Item -ItemType Directory -Path $dest -Force | Out-Null
$copied = 0
foreach ($f in (Get-ChildItem $src -File)) {
    if ($f.Name -eq 'install.ps1') { continue }
    Copy-Item $f.FullName (Join-Path $dest $f.Name) -Force
    $copied++
}
foreach ($d in (Get-ChildItem $src -Directory)) {
    Copy-Item $d.FullName (Join-Path $dest $d.Name) -Recurse -Force
    $copied++
}
Write-Host "  [OK] Copied $copied item(s)" -ForegroundColor Green

Write-Host ""
Write-Host "=== Verify ===" -ForegroundColor Cyan
$skillFile = Join-Path $dest 'SKILL.md'
if (-not (Test-Path $skillFile)) {
    Write-Host "  [X] SKILL.md was not copied" -ForegroundColor Red
    exit 1
}

$head = Get-Content $skillFile -TotalCount 1
if ($head -ne '---') {
    Write-Host "  [X] SKILL.md has no frontmatter" -ForegroundColor Red
    exit 1
}

# DSH does not tolerate a BOM when parsing frontmatter.
$bytes = [System.IO.File]::ReadAllBytes($skillFile)
if ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Write-Host "  [X] SKILL.md has a BOM - frontmatter will fail to parse" -ForegroundColor Red
    Write-Host "      Re-save it as UTF-8 without BOM" -ForegroundColor Yellow
    exit 1
}
Write-Host "  [OK] SKILL.md frontmatter OK, no BOM" -ForegroundColor Green

Write-Host ""
Write-Host "=== Portability self-test ===" -ForegroundColor Cyan
$node = $null
if (Get-Command node -ErrorAction SilentlyContinue) { $node = 'node' }
elseif ($env:DSH_APP_EXE -and (Test-Path $env:DSH_APP_EXE)) { $node = $env:DSH_APP_EXE }

if ($node) {
    & $node (Join-Path $dest 'selftest-portable.mjs') 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [!] Self-test did not fully pass (check node >= 22)" -ForegroundColor Yellow
    }
} else {
    Write-Host "  [!] node not found, skipping self-test. Run manually later:" -ForegroundColor Yellow
    Write-Host "      node `"$(Join-Path $dest 'selftest-portable.mjs')`"" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "  Restart DSH for the skill to appear."
Write-Host "  Usage: node `"$(Join-Path $dest 'check.mjs')`" `"<workspace-path>`""
Write-Host ""
