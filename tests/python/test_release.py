"""What the release depends on stays consistent: pinned versions and hashes, CI on the same Node
and Python as the installer bundles, locked Python packages, one product version."""
import json
import re
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))


def _pins() -> dict[str, dict[str, str]]:
    """installer/versions.psd1 as {tool: {Version, Url, Sha256}} (a plain PowerShell data file)."""
    text = (ROOT / "installer" / "versions.psd1").read_text("utf-8")
    pins = {}
    for m in re.finditer(r"^\s*(\w+)\s*=\s*@\{(.*?)\}", text, re.M | re.S):
        pins[m.group(1)] = dict(re.findall(r"(\w+)\s*=\s*'([^']*)'", m.group(2)))
    return pins


def _workflow(name: str) -> dict:
    return yaml.safe_load((ROOT / ".github" / "workflows" / name).read_text("utf-8"))


def test_bundled_binaries_are_pinned_with_a_hash():
    pins = _pins()
    assert set(pins) == {"Node", "FFmpeg", "Python", "InnoSetup"}
    for tool, pin in pins.items():
        assert re.fullmatch(r"\d+\.\d+\.\d+", pin["Version"]), tool
        assert re.fullmatch(r"[0-9a-f]{64}", pin["Sha256"]), tool
        assert pin["Url"].startswith("https://") and "latest" not in pin["Url"], tool
        assert pin["Version"].replace(".", "_") in pin["Url"] or pin["Version"] in pin["Url"], f"{tool}: the URL is not for {pin['Version']}"


def test_ci_uses_the_node_and_python_the_installer_bundles():
    pins = _pins()
    ci = _workflow("ci.yml")
    assert ci["env"]["NODE_VERSION"] == pins["Node"]["Version"]
    assert ci["env"]["PYTHON_VERSION"] == pins["Python"]["Version"]
    for name in ("slow-tests.yml", "prepare-release.yml"):
        text = (ROOT / ".github" / "workflows" / name).read_text("utf-8")
        for v in re.findall(r"(node|python)-version: '([^']+)'", text):
            want = pins["Node" if v[0] == "node" else "Python"]["Version"]
            assert v[1] == want, f"{name}: {v[0]} {v[1]}, the installer bundles {want}"


def test_actions_are_pinned_to_commits():
    for wf in WORKFLOWS:
        for line in wf.read_text("utf-8").splitlines():
            m = re.match(r"\s*-?\s*uses:\s*(\S+)", line)
            if m and not m.group(1).startswith("./"):
                assert re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", m.group(1)), f"{wf.name}: {m.group(1)} is not pinned to a commit"


def test_only_release_jobs_may_write():
    """Read-only by default; contents: write only where a release is tagged or published."""
    writers = set()
    for wf in WORKFLOWS:
        d = yaml.safe_load(wf.read_text("utf-8"))
        assert d.get("permissions") == {"contents": "read"}, f"{wf.name}: top-level permissions must be contents: read"
        for name, job in d["jobs"].items():
            if "write" in (job.get("permissions") or {}).values():
                writers.add(f"{wf.name}:{name}")
    assert writers == {"installer.yml:release", "prepare-release.yml:prepare", "prepare-release.yml:release"}
    release = _workflow("installer.yml")["jobs"]["release"]
    assert "ref_type == 'tag'" in release["if"] and release["needs"] == "installer"


def _locked(path: Path) -> dict[str, tuple[str, int]]:
    """{package: (version, number of hashes)} of a lock file."""
    out, name = {}, None
    for line in path.read_text("utf-8").splitlines():
        if m := re.match(r"^([A-Za-z0-9_.-]+)==(\S+)", line):
            name = m.group(1).lower().replace("_", "-")
            out[name] = (m.group(2), 0)
        elif name and "--hash=sha256:" in line:
            out[name] = (out[name][0], out[name][1] + 1)
    return out


def _required(path: Path) -> set[str]:
    names = set()
    for line in path.read_text("utf-8").splitlines():
        line = line.split("#")[0].strip()
        if line.startswith("-r "):
            names |= _required((path.parent / line[3:]).resolve())
        elif line:
            names.add(re.split(r"[\s<>=!~;\[]", line, maxsplit=1)[0].lower().replace("_", "-"))
    return names


def test_python_locks_cover_the_requirements_with_hashes():
    """requirements*.txt say what is needed, the locks pin it (npm run lock:py). A requirement
    without its pin would make pip --require-hashes fail in the installer build."""
    runtime = _locked(ROOT / "requirements-lock.txt")
    dev = _locked(ROOT / "requirements-dev-lock.txt")
    missing = _required(ROOT / "apps" / "worker" / "requirements.txt") - set(runtime)
    assert not missing, f"not in requirements-lock.txt: {missing} - run npm run lock:py"
    missing = _required(ROOT / "requirements-dev.txt") - set(dev)
    assert not missing, f"not in requirements-dev-lock.txt: {missing} - run npm run lock:py"
    assert all(n > 0 for _, n in runtime.values()) and all(n > 0 for _, n in dev.values())
    assert {"onnxruntime", "onnxruntime-directml"} <= set(runtime)
    # CI installs the dev lock: it must test exactly the versions that ship.
    differ = {k: (v[0], dev[k][0]) for k, v in runtime.items() if k in dev and dev[k][0] != v[0]}
    assert not differ and set(runtime) <= set(dev), f"the two locks disagree: {differ} - run npm run lock:py"


def test_one_product_version():
    root = json.loads((ROOT / "package.json").read_text("utf-8"))
    for ws in root["workspaces"]:
        pkg = json.loads((ROOT / ws / "package.json").read_text("utf-8"))
        assert pkg["version"] == root["version"], f"{ws} is {pkg['version']}, the app is {root['version']} (node scripts/bump-version.mjs)"
        for dep, spec in {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}.items():
            if dep.startswith("@golf/"):
                assert spec == root["version"], f"{ws}: {dep}@{spec}"


@pytest.mark.skipif(sys.platform != "win32", reason="onnxruntime-directml is the Windows build")
def test_directml_is_installed_on_windows():
    import onnxruntime as ort

    assert "DmlExecutionProvider" in ort.get_available_providers()
