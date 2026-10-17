[CmdletBinding()]
param(
    [ValidateSet('Codex','DSH')][string]$Target = 'Codex',
    [string]$Destination,
    [switch]$Force
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
if ($src.TrimEnd('\','/') -eq $dest.TrimEnd('\','/')) { throw 'Source equals destination' }
if (Test-Path -LiteralPath $dest) {
    if (-not $Force) { throw 'Destination exists; use -Force to back it up and replace it' }
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
& $nodePath (Join-Path $src 'selftest-portable.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Source self-test failed; no installed files changed' }
$parent = Split-Path -Parent $dest
New-Item -ItemType Directory -Path $parent -Force | Out-Null
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
    $backupRoot = Join-Path (Split-Path -Parent $parent) 'skill-backups'
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $backup = Join-Path $backupRoot ('workspace-main-conversation-' + [guid]::NewGuid().ToString('N'))
    # Resolve both endpoints before moving the explicitly selected installation.
    $existingPath = (Resolve-Path -LiteralPath $dest).ProviderPath
    if ([IO.Path]::GetFullPath($existingPath) -ne $dest) { throw 'Destination validation failed' }
    if ([IO.Path]::GetFullPath((Split-Path -Parent $backup)) -ne [IO.Path]::GetFullPath($backupRoot)) { throw 'Backup validation failed' }
    Move-Item -LiteralPath $dest -Destination $backup
}
try { Move-Item -LiteralPath $stage -Destination $dest }
catch {
    if ($backup -and -not (Test-Path -LiteralPath $dest)) { Move-Item -LiteralPath $backup -Destination $dest }
    throw
}
[pscustomobject]@{ installed=$dest; backup=$backup; target=$Target } | ConvertTo-Json -Compress
