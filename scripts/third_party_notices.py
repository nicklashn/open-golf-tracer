"""Writes THIRD_PARTY_NOTICES.txt: the licences of everything the Windows installer ships besides
Open Golf Tracer's own MIT code.

    python scripts/third_party_notices.py [--root DIR] [--out FILE]

installer/build.ps1 runs it with the bundled Python after the pip and npm installs, so the
Python and npm lists are exactly what is in the installer. --root is the folder that holds
runtime/, node_modules/ and package-lock.json (default: this checkout). Each package's own licence
file ships unchanged in its folder (runtime/python/Lib/site-packages, node_modules); this file
summarises them and carries the full texts of the bundled programs (Node.js, Python, FFmpeg) and
the ball detector's weights.
"""
from __future__ import annotations

import argparse
import importlib.metadata as md
import json
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULE = "=" * 100

PBS_COMPONENTS = """\
python-build-standalone (https://github.com/astral-sh/python-build-standalone, MPL-2.0 build scripts)
builds CPython together with these libraries, each under its own licence:
  OpenSSL (Apache-2.0), SQLite (public domain), libffi (MIT), zlib (Zlib), bzip2 (bzip2-1.0.6),
  xz/liblzma (0BSD), mpdecimal (BSD-2-Clause), expat (MIT), Tcl/Tk (TCL licence, BSD-style).
The CPython licence text below (LICENSE.txt in runtime/python) covers Python itself and lists the
licences of the code included in the standard library."""


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


def _run_version(exe: str | None, *args: str) -> str:
    if not exe:
        return ""
    try:
        return subprocess.run([exe, *args], capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _exe(root: Path, rel: str, name: str) -> str | None:
    for cand in (root / rel / f"{name}.exe", root / rel / name):
        if cand.exists():
            return str(cand)
    return shutil.which(name)


def ffmpeg_section(root: Path) -> str:
    exe = _exe(root, "runtime/ffmpeg/bin", "ffmpeg")
    out = _run_version(exe, "-hide_banner", "-version")
    first = out.splitlines()[0].split(" Copyright")[0] if out else "ffmpeg (not found when this file was generated)"
    config = next((ln for ln in out.splitlines() if ln.startswith("configuration:")), "")
    gpl3 = "--enable-gpl" in config and "--enable-version3" in config
    gpl = "--enable-gpl" in config
    licence = "GPL-3.0-or-later" if gpl3 else "GPL-2.0-or-later" if gpl else "LGPL-2.1-or-later (or GPL, see its LICENSE)"
    m = re.search(r"ffmpeg version (?:n)?(\d+(?:\.\d+)+)", first)
    if m:
        source = f"https://ffmpeg.org/releases/ffmpeg-{m[1]}.tar.xz"
    else:
        g = re.search(r"-g([0-9a-f]{7,40})", first)
        source = f"https://github.com/FFmpeg/FFmpeg/commit/{g[1]}" if g else "https://ffmpeg.org/download.html"
    lic = _read(root / "runtime/ffmpeg/LICENSE") or _read(root / "runtime/ffmpeg/LICENSE.txt")
    readme = _read(root / "runtime/ffmpeg/README.txt")
    parts = [
        f"FFmpeg - {first}",
        f"Licence: {licence}." + (" Build: gyan.dev \"release essentials\" (https://www.gyan.dev/ffmpeg/builds/), shipped unchanged"
                                  " in runtime/ffmpeg together with its LICENSE and README.txt." if "gyan.dev" in first else ""),
        f"Corresponding source code: {source}",
        "The build's configuration, external libraries and their versions are listed in runtime/ffmpeg/README.txt"
        " and by `ffmpeg -version`. Open Golf Tracer runs ffmpeg/ffprobe as separate programs and does not link to them.",
    ]
    if config:
        parts.append(config)
    if lic:
        parts += ["", "--- runtime/ffmpeg/LICENSE ---", lic]
    if readme:
        parts += ["", "--- runtime/ffmpeg/README.txt ---", readme]
    return "\n".join(parts)


def node_section(root: Path) -> str:
    exe = _exe(root, "runtime/node", "node")
    version = _run_version(exe, "--version") or "(not found when this file was generated)"
    lic = _read(root / "runtime/node/LICENSE")
    head = f"Node.js {version} - MIT licence (https://nodejs.org). Shipped in runtime/node; its LICENSE lists the bundled" \
           " components (V8, libuv, OpenSSL, ICU, npm, ...) and their licences."
    return head + ("\n\n--- runtime/node/LICENSE ---\n" + lic if lic else "")


def python_section() -> str:
    base = Path(sys.base_prefix)
    lic = _read(base / "LICENSE.txt") or _read(base / "LICENSE") or _read(Path(sys.prefix) / "LICENSE.txt")
    head = f"Python {sys.version.split()[0]} - Python Software Foundation License Version 2 (PSF-2.0). {PBS_COMPONENTS}"
    return head + ("\n\n--- runtime/python/LICENSE.txt ---\n" + lic if lic else "")


def model_section(root: Path) -> str:
    lic = _read(root / "models/LICENSE-rf-detr") or _read(ROOT / "models/LICENSE-rf-detr")
    return ("Ball detector: RF-DETR Large (Roboflow, https://github.com/roboflow/rf-detr), COCO-pretrained weights exported\n"
            "to ONNX (models/rf-detr-large.onnx, weights unchanged). Licence: Apache-2.0. The upstream project has no NOTICE file.\n"
            "Full text: models/LICENSE-rf-detr" + ("\n\n--- models/LICENSE-rf-detr ---\n" + lic if lic else ""))


def fonts_section(root: Path) -> str:
    names = sorted({p.name.replace("-OFL.txt", "") for p in (root / "assets/fonts").glob("*-OFL.txt")})
    return ("Fonts: " + ", ".join(names) + " - SIL Open Font License 1.1. Latin subsets in assets/fonts/static;\n"
            "Playfair Display is renamed \"GT Serif Display\" because of its Reserved Font Name. Licence texts: assets/fonts/*-OFL.txt.")


def dist_licence(dist: md.Distribution) -> str:
    meta = dist.metadata
    expr = (meta.get("License-Expression") or "").strip()
    if expr:
        return expr
    lic = (meta.get("License") or "").strip()
    if lic and "\n" not in lic and len(lic) <= 80 and lic.upper() != "UNKNOWN":
        return lic
    classifiers = [c.split("::")[-1].strip() for c in (meta.get_all("Classifier") or []) if c.startswith("License ::")]
    classifiers = [c for c in classifiers if c != "OSI Approved"]
    if classifiers:
        return " / ".join(classifiers)
    if lic:
        return lic.splitlines()[0][:80] + " (see its licence file)"
    return "UNKNOWN (see its licence file)"


def python_packages() -> list[tuple[str, str, str]]:
    seen: dict[str, tuple[str, str, str]] = {}
    for d in md.distributions():
        name = d.metadata.get("Name")
        if name and name.lower() not in seen:
            seen[name.lower()] = (name, d.version, dist_licence(d))
    return sorted(seen.values(), key=lambda x: x[0].lower())


def npm_packages(root: Path) -> list[tuple[str, str, str, bool]]:
    try:
        lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    on_disk = (root / "node_modules").is_dir()
    out = []
    for key, info in lock.get("packages", {}).items():
        if not key.startswith("node_modules/") or info.get("link"):
            continue
        if on_disk and not (root / key).is_dir():
            continue  # an optional package for another platform
        name = key.rsplit("node_modules/", 1)[1]
        licence = info.get("license")
        if not licence:
            pkg = root / key / "package.json"
            try:
                licence = json.loads(pkg.read_text(encoding="utf-8")).get("license")
            except (OSError, ValueError):
                licence = None
        if isinstance(licence, dict):
            licence = licence.get("type")
        out.append((name, str(info.get("version", "")), str(licence or "UNKNOWN (see its licence file)"), bool(info.get("dev"))))
    out += standalone_packages(root)
    return sorted(set(out), key=lambda x: (x[0].lower(), x[1]))


STANDALONE = Path("apps/web/.next/standalone/node_modules")


def standalone_packages(root: Path) -> list[tuple[str, str, str, bool]]:
    """The packages Next.js copied into the web app's standalone server (next, react, …): the
    installer runs the web app from there and keeps only the exporter's packages in node_modules."""
    base = root / STANDALONE
    out = []
    for pkg in sorted(base.rglob("package.json")) if base.is_dir() else []:
        d = pkg.parent
        # Only a package's own package.json: node_modules/<name>/ or node_modules/@scope/<name>/.
        scoped = d.parent.name.startswith("@") and (d.parent.parent == base or d.parent.parent.name == "node_modules")
        if not (scoped or d.parent == base or d.parent.name == "node_modules"):
            continue
        try:
            info = json.loads(pkg.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        name = info.get("name")
        if name != (f"{d.parent.name}/{d.name}" if scoped else d.name) or name.startswith("@golf/"):
            continue
        licence = info.get("license")
        if isinstance(licence, dict):
            licence = licence.get("type")
        out.append((name, str(info.get("version", "")), str(licence or "UNKNOWN (see its licence file)"), False))
    return out


def summary(rows: list[tuple[str, ...]]) -> str:
    counts: dict[str, int] = defaultdict(int)
    for r in rows:
        counts[r[2]] += 1
    return "\n".join(f"  {n:5d}  {lic}" for lic, n in sorted(counts.items(), key=lambda x: (-x[1], x[0])))


def build(root: Path) -> str:
    try:
        version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError):
        version = "?"
    py = python_packages()
    npm = npm_packages(root)
    sections = [
        f"Open Golf Tracer {version} - third-party notices\n\n"
        "Open Golf Tracer itself is MIT licensed (LICENSE). The Windows installer also ships the programs, models,\n"
        "fonts and packages below, each under its own licence. Each package's own licence file is included unchanged\n"
        "in its folder. Licence overview and reasoning: docs/licensing.md.",
        node_section(root),
        python_section(),
        ffmpeg_section(root),
        "ONNX Runtime (onnxruntime / onnxruntime-directml, Microsoft) - MIT. onnxruntime-directml contains Microsoft's\n"
        "DirectML.dll, redistributed unchanged as Microsoft ships it in that wheel under its own licence terms; the\n"
        "wheel's licence and ThirdPartyNotices files are in runtime/python/Lib/site-packages/onnxruntime*.dist-info\n"
        "and onnxruntime/.",
        model_section(root),
        fonts_section(root),
        f"Python packages ({len(py)}) by licence:\n{summary(py)}\n\n" + "\n".join(f"  {n} {v} - {lic}" for n, v, lic in py),
        f"npm packages ({len(npm)}) by licence (\"build\" = only used to build or test):\n"
        f"{summary(npm)}\n\n" + "\n".join(f"  {n} {v} - {lic}{'  (build)' if dev else ''}" for n, v, lic, dev in npm),
    ]
    return ("\n\n" + RULE + "\n\n").join(sections) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", type=Path, default=ROOT)
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args(argv)
    out = a.out or a.root / "THIRD_PARTY_NOTICES.txt"
    text = build(a.root)
    out.write_text(text, encoding="utf-8", newline="\r\n" if sys.platform == "win32" else "\n")
    print(f"wrote {out} ({len(text) // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
