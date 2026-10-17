[CmdletBinding()]
param(
    [ValidateSet('Codex','DSH')][string]$Target = 'Codex',
    [string]$Destination,
    [switch]$Force,
    [switch]$MergeLegacy
)
$ErrorActionPreference = 'Stop'
if (-not $Destination) {
    if ($Target -eq 'Codex') {
        $skillHome = if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills' } else { Join-Path $env:USERPROFILE '.agents\skills' }
    } else {
        $dataHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
        $skillHome = Join-Path $dataHome 'skills'
    }
    $Destination = Join-Path $skillHome 'workspace-main-conversation'
}
$src = [IO.Path]::GetFullPath($PSScriptRoot)
$dest = [IO.Path]::GetFullPath($Destination)
if ($MergeLegacy -and (Split-Path -Leaf $dest) -ne 'workspace-main-conversation') { throw 'MergeLegacy requires the canonical skill directory name' }
if ($src.TrimEnd('\','/') -eq $dest.TrimEnd('\','/')) { throw 'Source equals destination' }
if (Test-Path -LiteralPath $dest) {
    if (-not $Force) { throw 'Destination exists; use -Force to back it up and replace it' }
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
& $nodePath (Join-Path $src 'selftest-portable.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Source self-test failed; no installed files changed' }
$parent = Split-Path -Parent $dest
New-Item -ItemType Directory -Path $parent -Force | Out-Null
# Keep backups outside the skill scan root so a stale copy is not rediscovered as
# another skill. Fall back to $parent when the parent is a drive/filesystem root.
$scanRoot = Split-Path -Parent $parent
if (-not $scanRoot -or (Split-Path -Parent $scanRoot) -eq $scanRoot -or [IO.Path]::GetFullPath($scanRoot) -eq [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($parent))) {
    $scanRoot = $parent
}
$backupRoot = Join-Path $scanRoot 'skill-backups'
$stage = Join-Path $parent ('.workspace-skill-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($item in (Get-ChildItem -LiteralPath $src -Force)) {
    if ($item.Name -in @('.git','install.ps1')) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $stage -Recurse -Force
}
& $nodePath (Join-Path $stage 'selftest-portable.mjs')
if ($LASTEXITCODE -ne 0) { throw ('Staged self-test failed; stage retained at ' + $stage) }
$backup = $null
if (Test-Path -LiteralPath $dest) {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $backup = Join-Path $backupRoot ('workspace-main-conversation-' + [guid]::NewGuid().ToString('N'))
    # Resolve both endpoints before moving the explicitly selected installation.
    $existingPath = (Resolve-Path -LiteralPath $dest).ProviderPath
    if ([IO.Path]::GetFullPath($existingPath) -ne $dest) { throw 'Destination validation failed' }
    if ([IO.Path]::GetFullPath((Split-Path -Parent $backup)) -ne [IO.Path]::GetFullPath($backupRoot)) { throw 'Backup validation failed' }
    Move-Item -LiteralPath $dest -Destination $backup
}
if ([IO.Path]::GetFullPath((Resolve-Path -LiteralPath $stage).ProviderPath) -ne [IO.Path]::GetFullPath($stage)) { throw 'Stage path validation failed' }
if ([IO.Path]::GetFullPath((Split-Path -Parent $stage)) -ne [IO.Path]::GetFullPath($parent)) { throw 'Stage outside install root' }
if ([IO.Path]::GetFullPath((Split-Path -Parent $dest)) -ne [IO.Path]::GetFullPath($parent)) { throw 'Destination outside install root' }
try { Move-Item -LiteralPath $stage -Destination $dest }
catch {
    if ($backup -and -not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $backup -Destination $dest }
    throw
}
$legacyBackup = $null
if ($MergeLegacy) {
    $legacy = Join-Path $parent 'detect-concurrent-workspace-edits'
    if (Test-Path -LiteralPath (Join-Path $legacy 'SKILL.md')) {
        $legacyRoot = Join-Path (Split-Path -Parent $parent) 'skill-backups'
        New-Item -ItemType Directory -Path $legacyRoot -Force | Out-Null
        $legacyBackup = Join-Path $legacyRoot ('detect-concurrent-workspace-edits-' + [guid]::NewGuid().ToString('N'))
        $legacyResolved = (Resolve-Path -LiteralPath $legacy).ProviderPath
        if ([IO.Path]::GetFullPath($legacyResolved) -ne [IO.Path]::GetFullPath($legacy)) { throw 'Legacy path validation failed' }
        if ([IO.Path]::GetFullPath((Split-Path -Parent $legacy)) -ne [IO.Path]::GetFullPath($parent)) { throw 'Legacy source outside skill root' }
        if ([IO.Path]::GetFullPath((Split-Path -Parent $legacyBackup)) -ne [IO.Path]::GetFullPath($legacyRoot)) { throw 'Legacy backup outside backup root' }
        Move-Item -LiteralPath $legacy -Destination $legacyBackup
        New-Item -ItemType Directory -Path $legacy | Out-Null
        $encoding = New-Object Text.UTF8Encoding $false
        foreach ($script in @('list-sessions.mjs','peek-session.mjs')) {
            [IO.File]::WriteAllText((Join-Path $legacy $script), ("import '../workspace-main-conversation/" + $script + "';" + [Environment]::NewLine), $encoding)
        }
    }
}
[pscustomobject]@{ installed=$dest; backup=$backup; legacyBackup=$legacyBackup; target=$Target } | ConvertTo-Json -Compress
