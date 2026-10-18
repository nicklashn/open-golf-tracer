"""scripts/third_party_notices.py: THIRD_PARTY_NOTICES.txt lists the bundled programs with their
licences and source, the model licence, and every installed Python and npm package."""
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("third_party_notices", ROOT / "scripts/third_party_notices.py")
tpn = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
sys.modules["third_party_notices"] = tpn
spec.loader.exec_module(tpn)  # type: ignore[union-attr]


def test_notices_for_a_stage(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({"version": "9.8.7"}))
    (tmp_path / "package-lock.json").write_text(json.dumps({"packages": {
        "": {"version": "9.8.7"},
        "node_modules/leaflet": {"version": "1.9.4", "license": "BSD-2-Clause"},
        "node_modules/@scope/tool": {"version": "2.0.0", "license": "MIT", "dev": True},
        "node_modules/@scope/tool/node_modules/inner": {"version": "0.1.0"},
        "node_modules/@img/sharp-linux-x64": {"version": "0.35.5", "license": "Apache-2.0", "optional": True},
        "node_modules/@golf/web": {"link": True, "resolved": "apps/web"},
    }}))
    for d in ("leaflet", "@scope/tool", "@scope/tool/node_modules/inner"):
        (tmp_path / "node_modules" / d).mkdir(parents=True)
    (tmp_path / "node_modules/@scope/tool/node_modules/inner/package.json").write_text(json.dumps({"license": "ISC"}))
    (tmp_path / "models").mkdir()
    (tmp_path / "models/LICENSE-rf-detr").write_text("Apache License\nVersion 2.0, January 2004\nCopyright 2025 Roboflow, Inc.")
    (tmp_path / "runtime/ffmpeg").mkdir(parents=True)
    (tmp_path / "runtime/ffmpeg/LICENSE").write_text("GNU GENERAL PUBLIC LICENSE Version 3")

    assert tpn.main(["--root", str(tmp_path)]) == 0
    text = (tmp_path / "THIRD_PARTY_NOTICES.txt").read_text(encoding="utf-8")
    assert text.startswith("Open Golf Tracer 9.8.7 - third-party notices")
    for want in ("Node.js", "Python Software Foundation License", "python-build-standalone", "FFmpeg - ", "Corresponding source code: https://",
                 "GNU GENERAL PUBLIC LICENSE Version 3", "ONNX Runtime", "DirectML.dll", "RF-DETR Large", "Copyright 2025 Roboflow, Inc.",
                 "SIL Open Font License", "leaflet 1.9.4 - BSD-2-Clause", "@scope/tool 2.0.0 - MIT  (build)", "inner 0.1.0 - ISC",
                 "npm packages (3)", "fastapi "):
        assert want in text, want
    assert "sharp-linux-x64" not in text and "@golf/web" not in text   # not on disk / a workspace link


def test_ffmpeg_source_links():
    # The licence follows the build's configuration; the source link its version.
    sec = tpn.ffmpeg_section(Path("/nonexistent"))
    assert "Corresponding source code: https://" in sec


def test_dist_licence_prefers_spdx():
    class D:
        def __init__(self, meta):
            self.metadata = meta

    class M(dict):
        def get_all(self, k):
            return self.get(k + "s")

    assert tpn.dist_licence(D(M({"License-Expression": "MIT"}))) == "MIT"
    assert tpn.dist_licence(D(M({"License": "BSD-3-Clause"}))) == "BSD-3-Clause"
    assert tpn.dist_licence(D(M({"Classifiers": ["License :: OSI Approved :: Apache Software License"]}))) == "Apache Software License"
    assert "see its licence file" in tpn.dist_licence(D(M({"License": "Long text\nwith lines"})))


def test_the_web_apps_standalone_packages_are_listed(tmp_path):
    """The installer runs the web app from .next/standalone, whose node_modules (next, react, …) is
    not in the pruned root node_modules: those packages ship too and must be listed."""
    (tmp_path / "package-lock.json").write_text(json.dumps({"packages": {"node_modules/zod": {"version": "4.0.0", "license": "MIT"}}}))
    (tmp_path / "node_modules/zod").mkdir(parents=True)
    sa = tmp_path / tpn.STANDALONE
    for d, info in {"next": {"name": "next", "version": "15.5.0", "license": "MIT"},
                    "@swc/helpers": {"name": "@swc/helpers", "version": "0.5.15", "license": "Apache-2.0"},
                    "next/node_modules/postcss": {"name": "postcss", "version": "8.4.31", "license": "MIT"},
                    "next/dist/compiled/x": {"name": "not-a-package"},
                    "@golf/web": {"name": "@golf/web", "version": "0.0.0"}}.items():
        (sa / d).mkdir(parents=True)
        (sa / d / "package.json").write_text(json.dumps(info))
    names = {(n, v, lic) for n, v, lic, _ in tpn.npm_packages(tmp_path)}
    assert names == {("zod", "4.0.0", "MIT"), ("next", "15.5.0", "MIT"), ("@swc/helpers", "0.5.15", "Apache-2.0"), ("postcss", "8.4.31", "MIT")}
