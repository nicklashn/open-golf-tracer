<#
.SYNOPSIS
  Builds the Windows installer: installer\dist\OpenGolfTracer-Setup-<version>.exe

.DESCRIPTION
  1. Exports the committed code (git HEAD - uncommitted changes are not included) to installer\build\stage.
  2. Downloads portable Node.js, FFmpeg (gyan.dev essentials) and uv, checking their SHA-256.
  3. Installs the npm packages and builds the web app with that Node, so the user's PC never has to.
  4. Compiles OpenGolfTracer.iss with Inno Setup 6 (winget install JRSoftware.InnoSetup).
  Downloads are cached in installer\build\downloads.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File installer\build.ps1 -Version 0.2.0
#>
param(
  [string]$Version,
  [int]$NodeMajor = 24,
  [switch]$StageOnly # stop before Inno Setup (for testing the stage)
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path $PSScriptRoot
$build = Join-Path $PSScriptRoot 'build'
$stage = Join-Path $build 'stage'
$downloads = Join-Path $build 'downloads'
if (-not $Version) { $Version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version }
$Version = $Version.TrimStart('v')

function Step($text) { Write-Host "`n== $text ==" -ForegroundColor Cyan }

function Invoke-Native {
  param([string]$Exe, [string[]]$Arguments)
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed ($LASTEXITCODE)" }
}

# Downloads $Url to the cache unless a copy with the expected SHA-256 is already there.
function Get-Verified([string]$Url, [string]$Sha256) {
  $file = Join-Path $downloads ([IO.Path]::GetFileName(([Uri]$Url).AbsolutePath))
  $want = $Sha256.Trim().ToLower()
  if ((Test-Path $file) -and (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -eq $want) { return $file }
  Write-Host "  downloading $Url"
  Invoke-WebRequest $Url -OutFile $file -UseBasicParsing
  $got = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want) { Remove-Item $file; throw "Checksum mismatch for $Url (expected $want, got $got)" }
  return $file
}

function Get-Text([string]$Url) {
  $c = (Invoke-WebRequest $Url -UseBasicParsing).Content
  if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) } # served as binary (e.g. .sha256 files)
  return $c
}

# Unpacks a zip with a single top-level folder to $Dest.
function Expand-Single([string]$Zip, [string]$Dest) {
  $tmp = Join-Path $build ('unpack-' + [IO.Path]::GetFileNameWithoutExtension($Zip))
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item -ItemType Directory $tmp | Out-Null
  Invoke-Native tar @('-xf', $Zip, '-C', $tmp)
  $inner = @(Get-ChildItem $tmp)
  $src = if ($inner.Count -eq 1 -and $inner[0].PSIsContainer) { $inner[0].FullName } else { $tmp }
  New-Item -ItemType Directory -Force (Split-Path $Dest) | Out-Null
  Move-Item $src $Dest
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
}

$iscc = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc -and -not $StageOnly) { throw 'Inno Setup 6 was not found. Install it with: winget install JRSoftware.InnoSetup' }

Step "Code (git HEAD) -> $stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage, $downloads | Out-Null
$tarball = Join-Path $build 'src.tar'
Invoke-Native git @('-C', $root, 'archive', '--format=tar', '-o', $tarball, 'HEAD')
Invoke-Native tar @('-xf', $tarball, '-C', $stage)
Remove-Item $tarball

Step "Node.js $NodeMajor (portable)"
$node = (Get-Text 'https://nodejs.org/dist/index.json' | ConvertFrom-Json) |
  Where-Object { $_.version -like "v$NodeMajor.*" -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
if (-not $node) { throw "No Node.js $NodeMajor release with a win-x64 zip was found" }
$nodeZip = "node-$($node.version)-win-x64.zip"
$nodeSum = ((Get-Text "https://nodejs.org/dist/$($node.version)/SHASUMS256.txt") -split "`n" |
  Where-Object { $_ -match "\s$([regex]::Escape($nodeZip))$" }) -split '\s+' | Select-Object -First 1
Write-Host "  $($node.version)"
Expand-Single (Get-Verified "https://nodejs.org/dist/$($node.version)/$nodeZip" $nodeSum) (Join-Path $stage 'runtime\node')

Step 'FFmpeg (gyan.dev release essentials)'
$ffUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
Expand-Single (Get-Verified $ffUrl (Get-Text "$ffUrl.sha256")) (Join-Path $stage 'runtime\ffmpeg')
Remove-Item (Join-Path $stage 'runtime\ffmpeg\doc') -Recurse -Force -ErrorAction SilentlyContinue

Step 'uv (Python installer)'
$uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
$uvSum = (Get-Text "$uvUrl.sha256").Trim() -split '\s+' | Select-Object -First 1
$uvDir = Join-Path $stage 'runtime\uv'
New-Item -ItemType Directory -Force $uvDir | Out-Null
Invoke-Native tar @('-xf', (Get-Verified $uvUrl $uvSum), '-C', $uvDir)

Step 'npm packages and web build'
$env:PATH = "$(Join-Path $stage 'runtime\node');$env:PATH"
$env:NEXT_TELEMETRY_DISABLED = '1'
Push-Location $stage
try {
  Invoke-Native npm.cmd @('ci', '--no-audit', '--no-fund')
  Invoke-Native npm.cmd @('run', 'build')
} finally { Pop-Location }
Remove-Item (Join-Path $stage 'apps\web\.next\cache') -Recurse -Force -ErrorAction SilentlyContinue

if ($StageOnly) { Write-Host "`nStage ready: $stage" -ForegroundColor Green; return }

Step "Inno Setup -> installer\dist (version $Version)"
Invoke-Native $iscc @("/DAppVersion=$Version", (Join-Path $PSScriptRoot 'OpenGolfTracer.iss'))
Write-Host "`nDone: $(Join-Path $PSScriptRoot "dist\OpenGolfTracer-Setup-$Version.exe")" -ForegroundColor Green
