<#
.SYNOPSIS
  Builds the Windows installer: installer\dist\OpenGolfTracer-Setup-<version>.exe

.DESCRIPTION
  1. Exports the committed code (git HEAD - uncommitted changes are not included) to installer\build\stage.
  2. Downloads portable Node.js, FFmpeg (gyan.dev essentials) and Python 3.12 (python-build-standalone,
     fetched with uv), checking their SHA-256. Python is a plain folder: no junctions, which newer
     Windows 11 builds refuse to follow for unprivileged processes (error 448).
     The Python packages go straight into that Python, and the ball detector (RF-DETR as ONNX) into
     models\, so the installed app needs no downloads at all.
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

Step 'Python 3.12 (portable)'
$uvUrl = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
$uvSum = (Get-Text "$uvUrl.sha256").Trim() -split '\s+' | Select-Object -First 1
$uvDir = Join-Path $build 'uv'
if (Test-Path $uvDir) { Remove-Item $uvDir -Recurse -Force }
New-Item -ItemType Directory -Force $uvDir | Out-Null
Invoke-Native tar @('-xf', (Get-Verified $uvUrl $uvSum), '-C', $uvDir)
$env:UV_SYSTEM_CERTS = '1' # the OS certificate store, for PCs where antivirus intercepts HTTPS
$pyDir = Join-Path $build 'python'
Invoke-Native (Join-Path $uvDir 'uv.exe') @('python', 'install', '3.12', '--install-dir', $pyDir, '--no-bin', '--no-registry')
# The real folder (cpython-3.12.N-windows-...), not uv's minor-version junction next to it.
$py = Get-ChildItem $pyDir -Directory | Where-Object {
  $_.Name -like 'cpython-3.12.*' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Test-Path (Join-Path $_.FullName 'python.exe'))
} | Sort-Object { [version]($_.Name -replace '^cpython-([\d.]+)-.*$', '$1') } -Descending | Select-Object -First 1
if (-not $py) { throw "uv did not install Python 3.12 into $pyDir" }
Write-Host "  $($py.Name)"
Copy-Item $py.FullName (Join-Path $stage 'runtime\python') -Recurse

Step 'Python packages (into the bundled Python)'
$stagePy = Join-Path $stage 'runtime\python\python.exe'
# uv marks its Pythons as externally managed (PEP 668); this copy is the app's own.
Remove-Item (Join-Path $stage 'runtime\python\Lib\EXTERNALLY-MANAGED') -ErrorAction SilentlyContinue
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
Invoke-Native $stagePy @('-m', 'pip', 'install', '--no-cache-dir', '--no-warn-script-location',
  '-r', (Join-Path $stage 'apps\worker\requirements.txt'))
Invoke-Native $stagePy @('-c', 'import onnxruntime as ort, cv2, numba, fastapi; print(ort.__version__, ort.get_available_providers())')

Step 'Ball detector (RF-DETR as ONNX)'
$detect = Get-Content (Join-Path $stage 'shottracer\detect.py') -Raw
$onnxUrl = [regex]::Match($detect, 'ONNX_URL = "([^"]+)"').Groups[1].Value
$onnxSum = [regex]::Match($detect, 'ONNX_SHA256 = "([0-9a-f]{64})"').Groups[1].Value
if (-not $onnxUrl -or -not $onnxSum) { throw 'ONNX_URL / ONNX_SHA256 not found in shottracer\detect.py' }
New-Item -ItemType Directory -Force (Join-Path $stage 'models') | Out-Null
Copy-Item (Get-Verified $onnxUrl $onnxSum) (Join-Path $stage 'models\rf-detr-large.onnx')

Step 'npm packages and web build'
$env:PATH = "$(Join-Path $stage 'runtime\node');$env:PATH"
$env:NEXT_TELEMETRY_DISABLED = '1'
Push-Location $stage
try {
  Invoke-Native npm.cmd @('ci', '--no-audit', '--no-fund')
  Invoke-Native npm.cmd @('run', 'build')
} finally { Pop-Location }
Remove-Item (Join-Path $stage 'apps\web\.next\cache') -Recurse -Force -ErrorAction SilentlyContinue
# npm links the workspaces into node_modules\@golf with junctions, which Inno Setup packs as copies.
# web and exporter are started from their own folders, so their copies would only take up space.
foreach ($ws in 'web', 'exporter') { [IO.Directory]::Delete((Join-Path $stage "node_modules\@golf\$ws")) }

# THIRD_PARTY_NOTICES.txt from what is now in the stage (runtime\, site-packages, node_modules) - scripts/third_party_notices.py
Step 'Third-party notices'; Invoke-Native $stagePy @((Join-Path $stage 'scripts\third_party_notices.py'), '--root', $stage)

if ($StageOnly) { Write-Host "`nStage ready: $stage" -ForegroundColor Green; return }

Step "Inno Setup -> installer\dist (version $Version)"
Invoke-Native $iscc @("/DAppVersion=$Version", (Join-Path $PSScriptRoot 'OpenGolfTracer.iss'))
Write-Host "`nDone: $(Join-Path $PSScriptRoot "dist\OpenGolfTracer-Setup-$Version.exe")" -ForegroundColor Green
