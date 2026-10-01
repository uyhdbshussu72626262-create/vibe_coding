param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$RunAppRoot = 'D:\Rust_Desktop_app\run_app',
  [string]$SourceRoot = 'D:\Rust_Desktop_app\source_code'
)

$ErrorActionPreference = 'Stop'

$releaseDir = Join-Path $ProjectRoot 'src-tauri\target\release'
$portableExe = Join-Path $releaseDir 'daynora.exe'
if (-not (Test-Path -LiteralPath $portableExe)) {
  throw "Portable executable not found: $portableExe. Run npm run tauri:build first."
}

$installerDir = Join-Path $RunAppRoot 'installer'
$portableDir = Join-Path $RunAppRoot 'portable\Daynora'
New-Item -ItemType Directory -Force -Path $installerDir | Out-Null
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null

Copy-Item -LiteralPath $portableExe -Destination (Join-Path $portableDir 'Daynora.exe') -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'README.md') -Destination (Join-Path $portableDir 'README.md') -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $portableDir 'THIRD_PARTY_NOTICES.md') -Force

$nsisDir = Join-Path $releaseDir 'bundle\nsis'
if (Test-Path -LiteralPath $nsisDir) {
  $installer = Get-ChildItem -LiteralPath $nsisDir -Filter '*.exe' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($installer) {
    Copy-Item -LiteralPath $installer.FullName -Destination (Join-Path $installerDir $installer.Name) -Force
  }
}

$portableZip = Join-Path $RunAppRoot 'Daynora-portable.zip'
Compress-Archive -Path (Join-Path $portableDir '*') -DestinationPath $portableZip -CompressionLevel Optimal -Force

$staging = Join-Path $env:TEMP ('daynora-source-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$null = robocopy $ProjectRoot $staging /E /XD node_modules target gen dist .git /XF *.zip
if ($LASTEXITCODE -ge 8) {
  throw "robocopy failed with exit code $LASTEXITCODE"
}

$sourceZip = Join-Path $SourceRoot 'daynora-source.zip'
New-Item -ItemType Directory -Force -Path $SourceRoot | Out-Null
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $sourceZip -CompressionLevel Optimal -Force

Remove-Item -LiteralPath $staging -Recurse -Force

Write-Host "Installer directory: $installerDir"
Write-Host "Portable directory: $portableDir"
Write-Host "Portable zip: $portableZip"
Write-Host "Source zip: $sourceZip"
