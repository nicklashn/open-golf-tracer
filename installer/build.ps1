<#
.SYNOPSIS
  Builds the Windows installer: installer\dist\OpenGolfTracer-Setup-<version>.exe

.DESCRIPTION
  1. Exports the committed code (git HEAD - uncommitted changes are not included) to installer\build\stage.
  2. Downloads portable Node.js, FFmpeg (gyan.dev essentials) and Python 3.12 (python-build-standalone)
     in the exact versions pinned in installer\versions.psd1, checking their SHA-256. Python is a
     plain folder: no junctions, which newer Windows 11 builds refuse to follow for unprivileged
     processes (error 448).
     The Python packages go straight into that Python, from requirements-lock.txt with
     --require-hashes, and the ball detector (RF-DETR as ONNX) into models\, so the installed app
     needs no downloads at all.
  3. Installs the npm packages and builds the web app (Next.js standalone server) and the exporter
     (one bundled file) with that Node, so the user's PC never has to. The build tools are then
     dropped: node_modules keeps only what the exporter needs at run time.
  4. Compiles OpenGolfTracer.iss with Inno Setup 6 (-Iscc, else a standard install of it).
  Downloads are cached in installer\build\downloads.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File installer\build.ps1 -Version 0.2.0
#>
param(
  [string]$Version,
  [string]$Iscc,     # ISCC.exe of the pinned Inno Setup (CI); else the usual install folders are searched
  [switch]$StageOnly # stop before Inno Setup (for testing the stage)
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path $PSScriptRoot
$build = Join-Path $PSScriptRoot 'build'
$stage = Join-Path $build 'stage'
$downloads = Join-Path $build 'downloads'
$pins = Import-PowerShellDataFile (Join-Path $PSScriptRoot 'versions.psd1')
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

# Unpacks a zip/tar with a single top-level folder to $Dest.
function Expand-Single([string]$Archive, [string]$Dest) {
  $tmp = Join-Path $build ('unpack-' + [IO.Path]::GetFileNameWithoutExtension($Archive))
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item -ItemType Directory $tmp | Out-Null
  Invoke-Native tar @('-xf', $Archive, '-C', $tmp)
  $inner = @(Get-ChildItem $tmp)
  $src = if ($inner.Count -eq 1 -and $inner[0].PSIsContainer) { $inner[0].FullName } else { $tmp }
  New-Item -ItemType Directory -Force (Split-Path $Dest) | Out-Null
  Move-Item $src $Dest
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
}

# npm links the workspaces into node_modules\@golf with junctions. Deleting a junction with
# [IO.Directory]::Delete removes the link only, never the folder it points to.
function Remove-Links([string]$Dir) {
  if (-not (Test-Path $Dir)) { return }
  Get-ChildItem $Dir -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
    ForEach-Object { [IO.Directory]::Delete($_.FullName) }
}

# Deletes a folder that may hold those junctions without following them (rmdir does not either).
function Remove-Tree([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  Remove-Links (Join-Path $Path 'node_modules\@golf')
  Remove-Links (Join-Path $Path '@golf')
  Remove-Links $Path
  Invoke-Native cmd.exe @('/d', '/c', 'rmdir', '/s', '/q', $Path)
}

function Get-FolderMB([string]$Path) {
  try { [math]::Round(((Get-ChildItem $Path -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1MB)) } catch { '?' }
}

# The script must be UTF-8 with exactly one BOM (for the Danish texts); a second one breaks line 1.
$issBytes = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'OpenGolfTracer.iss'))
if ($issBytes[0] -ne 0xEF -or ($issBytes[3] -eq 0xEF -and $issBytes[4] -eq 0xBB)) { throw 'OpenGolfTracer.iss must start with exactly one UTF-8 BOM' }
# Inno Setup only notices a missing [CustomMessages] entry at run time, on the user's PC.
$iss = Get-Content (Join-Path $PSScriptRoot 'OpenGolfTracer.iss') -Raw -Encoding UTF8
$used = [regex]::Matches($iss, "CustomMessage\('(\w+)'") | ForEach-Object { $_.Groups[1].Value }
$missing = $used | Sort-Object -Unique | ForEach-Object {
  foreach ($lang in 'en', 'da') { if ($iss -notmatch "(?m)^$lang\.$_=") { "$lang.$_" } }
}
if ($missing) { throw "OpenGolfTracer.iss uses custom messages that are not defined: $($missing -join ', ')" }

if (-not $Iscc) {
  $Iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $StageOnly -and -not ($Iscc -and (Test-Path $Iscc))) { throw 'Inno Setup 6 was not found. Install it with: winget install JRSoftware.InnoSetup' }

Step "Code (git HEAD) -> $stage"
if (Test-Path $stage) { Remove-Tree $stage }
New-Item -ItemType Directory -Force $stage, $downloads | Out-Null
$tarball = Join-Path $build 'src.tar'
Invoke-Native git @('-C', $root, 'archive', '--format=tar', '-o', $tarball, 'HEAD')
Invoke-Native tar @('-xf', $tarball, '-C', $stage)
Remove-Item $tarball

Step "Node.js $($pins.Node.Version) (portable)"
Expand-Single (Get-Verified $pins.Node.Url $pins.Node.Sha256) (Join-Path $stage 'runtime\node')

Step "FFmpeg $($pins.FFmpeg.Version) (gyan.dev essentials)"
Expand-Single (Get-Verified $pins.FFmpeg.Url $pins.FFmpeg.Sha256) (Join-Path $stage 'runtime\ffmpeg')
Remove-Item (Join-Path $stage 'runtime\ffmpeg\doc') -Recurse -Force -ErrorAction SilentlyContinue

Step "Python $($pins.Python.Version) (portable)"
Expand-Single (Get-Verified $pins.Python.Url $pins.Python.Sha256) (Join-Path $stage 'runtime\python')
$stagePy = Join-Path $stage 'runtime\python\python.exe'
$pyVersion = (& $stagePy -c 'import platform; print(platform.python_version())').Trim()
if ($pyVersion -ne $pins.Python.Version) { throw "The bundled Python is $pyVersion, expected $($pins.Python.Version)" }

Step 'Python packages (requirements-lock.txt, into the bundled Python)'
# A uv-installed Python is marked as externally managed (PEP 668); this copy is the app's own.
Remove-Item (Join-Path $stage 'runtime\python\Lib\EXTERNALLY-MANAGED') -ErrorAction SilentlyContinue
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
# --require-hashes: every package, dependencies included, must be pinned with its hash in the lock
# (npm run lock:py); --only-binary: no package is built from source on the build machine.
Invoke-Native $stagePy @('-m', 'pip', 'install', '--no-cache-dir', '--no-warn-script-location', '--require-hashes',
  '--only-binary', ':all:', '-r', (Join-Path $stage 'requirements-lock.txt'))
Invoke-Native $stagePy @('-m', 'pip', 'check')
# The GPU (DirectML) build of ONNX Runtime must be the one installed, not the CPU-only one.
# (A file, not -c: Windows PowerShell mangles quotes in arguments to native programs.)
$check = Join-Path $build 'check-packages.py'
Set-Content $check -Encoding ASCII -Value @'
import onnxruntime as ort, cv2, numba, fastapi
providers = ort.get_available_providers()
print(ort.__version__, providers)
assert 'DmlExecutionProvider' in providers, 'onnxruntime-directml is missing: the detector would run on the CPU only'
'@
Invoke-Native $stagePy @('-I', $check)

Step 'Ball detector (RF-DETR as ONNX)'
$detect = Get-Content (Join-Path $stage 'shottracer\detect.py') -Raw
$onnxUrl = [regex]::Match($detect, 'ONNX_URL = "([^"]+)"').Groups[1].Value
$onnxSum = [regex]::Match($detect, 'ONNX_SHA256 = "([0-9a-f]{64})"').Groups[1].Value
if (-not $onnxUrl -or -not $onnxSum) { throw 'ONNX_URL / ONNX_SHA256 not found in shottracer\detect.py' }
New-Item -ItemType Directory -Force (Join-Path $stage 'models') | Out-Null
Copy-Item (Get-Verified $onnxUrl $onnxSum) (Join-Path $stage 'models\rf-detr-large.onnx')

Step 'npm packages, web build (standalone) and exporter bundle'
$env:PATH = "$(Join-Path $stage 'runtime\node');$env:PATH"
$env:NEXT_TELEMETRY_DISABLED = '1'
Push-Location $stage
try {
  Invoke-Native npm.cmd @('ci', '--no-audit', '--no-fund')
  Invoke-Native npm.cmd @('run', 'build')
  $nm = Join-Path $stage 'node_modules'
  $before = Get-FolderMB $nm
  # The web app runs from .next\standalone (with its own node_modules) and the exporter from
  # apps\exporter\dist, so the build tools go: only the exporter's run-time packages are kept.
  Remove-Tree $nm
  Invoke-Native npm.cmd @('ci', '--omit=dev', '--workspace', '@golf/exporter', '--no-audit', '--no-fund')
  Write-Host "  node_modules: $before MB -> $(Get-FolderMB $nm) MB"
} finally { Pop-Location }
foreach ($p in 'apps\web\.next\standalone\apps\web\server.js', 'apps\exporter\dist\main.mjs') {
  if (-not (Test-Path (Join-Path $stage $p))) { throw "The build did not make $p" }
}
Remove-Tree (Join-Path $stage 'apps\web\.next\cache')
# npm links the workspaces into node_modules\@golf with junctions, which Inno Setup packs as copies.
# Everything of theirs is bundled into the builds, so the links would only take up space.
Remove-Tree (Join-Path $stage 'node_modules\@golf')

Write-Host "  stage: $(Get-FolderMB $stage) MB"
if ($StageOnly) { Write-Host "`nStage ready: $stage" -ForegroundColor Green; return }

Step "Inno Setup -> installer\dist (version $Version)"
Invoke-Native $Iscc @("/DAppVersion=$Version", (Join-Path $PSScriptRoot 'OpenGolfTracer.iss'))
Write-Host "`nDone: $(Join-Path $PSScriptRoot "dist\OpenGolfTracer-Setup-$Version.exe")" -ForegroundColor Green
