# What the Windows installer bundles, pinned to exact versions and checked against SHA-256.
# build.ps1 and the workflows read this file; nothing is fetched as "latest".
#
# To update one: change Version, Url and Sha256 together and check the hash against the
# publisher's own list (Node: SHASUMS256.txt next to the zip; FFmpeg: the .sha256 next to the zip
# on gyan.dev; Python: SHA256SUMS in the python-build-standalone release; Inno Setup: compute it
# from the download on jrsoftware.org's page). Keep Node in step with node-version in
# .github/workflows/*.yml (tests/python/test_release.py checks it).
@{
  Node      = @{
    Version = '24.21.0'
    Url     = 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip'
    Sha256  = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
  }
  # gyan.dev "essentials" build; the GitHub mirror is gyan's own and keeps every version.
  FFmpeg    = @{
    Version = '9.0.2'
    Url     = 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip'
    Sha256  = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
  }
  # python-build-standalone (what uv installs), as a plain folder: no junctions, which newer
  # Windows 11 builds refuse to follow for unprivileged processes (error 448).
  Python    = @{
    Version = '3.12.15'
    Url     = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261001/cpython-3.12.15%2B20261001-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'
    Sha256  = '52124cee54126f3f360eaa378288f6f64c402c983a3c14c95eff67f4af986aaa'
  }
  InnoSetup = @{
    Version = '6.7.3'
    Url     = 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe'
    Sha256  = '9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732'
  }
}
