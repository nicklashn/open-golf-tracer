"""Performance profiles: how much of the PC the worker may use (Settings → Performance).

Stored in DATA_DIR/performance.json; the worker reads it before each job, so a new choice applies
to the next job without a restart. Hardware detection uses only the standard library and
`nvidia-smi` when it is there.
"""
from __future__ import annotations

import ctypes
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any

from .config import settings

PROFILES = ("gentle", "balanced", "max", "tuned")
FILE = "performance.json"
VRAM_LIMIT = 0.8          # never plan to fill more than this share of the GPU's memory
RAM_PER_ANALYSIS_MB = 3000  # one analysis holds ~4 s of full-HD frames plus the decoders
RAM_PER_INGEST_MB = 1000
MAX_ANALYSES = 4          # the worker starts this many analysis threads; the profile says how many work
MAX_INGESTS = 4


@dataclass(frozen=True)
class Perf:
    analyses: int = 1     # analyses at once
    ingests: int = 1      # videos prepared at once
    sessions: int = 1     # detector sessions (each costs GPU memory)
    batch: int = 1        # frames per detector call (models with a dynamic batch dimension only)
    threads: int = 0      # CPU threads for the detector, OpenCV and decoding; 0 = all cores
    gpu: bool = True      # False after repeated GPU errors: the detector runs on the CPU

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> Perf:
        d = d or {}
        cores = os.cpu_count() or 4

        def num(key: str, hi: int, lo: int = 1) -> int:
            try:
                return max(lo, min(hi, int(d.get(key, getattr(cls, key)))))
            except (TypeError, ValueError):
                return getattr(cls, key)

        return cls(num("analyses", MAX_ANALYSES), num("ingests", MAX_INGESTS), num("sessions", 8), num("batch", 16),
                   num("threads", cores, 0), bool(d.get("gpu", True)))


# --- hardware --------------------------------------------------------------------------------


def parse_nvidia_smi(text: str) -> list[dict[str, Any]]:
    """`nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv` (with or without
    header/units) -> [{name, vramMb, usedMb}]."""
    out = []
    for line in text.strip().splitlines():
        name, *nums = line.rsplit(",", 2)
        m = [re.match(r"\s*(\d+(?:\.\d+)?)", n) for n in nums]
        if len(m) != 2 or not (m[0] and m[1]) or name.strip().lower() == "name":
            continue
        out.append({"name": name.strip(), "vramMb": int(float(m[0][1])), "usedMb": int(float(m[1][1]))})
    return out


def parse_meminfo(text: str) -> dict[str, int]:
    """/proc/meminfo -> {totalMb, availableMb}."""
    kb = {}
    for line in text.splitlines():
        m = re.match(r"(\w+):\s+(\d+)", line)
        if m:
            kb[m[1]] = int(m[2])
    total = kb.get("MemTotal", 0)
    avail = kb.get("MemAvailable", kb.get("MemFree", 0) + kb.get("Cached", 0))
    return {"totalMb": total // 1024, "availableMb": avail // 1024}


def ram() -> dict[str, int]:
    if sys.platform == "win32":
        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong), ("ullTotalPhys", ctypes.c_ulonglong),
                        ("ullAvailPhys", ctypes.c_ulonglong), ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        st = MEMORYSTATUSEX()
        st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):  # type: ignore[attr-defined]
            return {"totalMb": st.ullTotalPhys // 2**20, "availableMb": st.ullAvailPhys // 2**20}
        return {"totalMb": 0, "availableMb": 0}
    try:
        return parse_meminfo(Path("/proc/meminfo").read_text())
    except OSError:
        try:
            total = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
            return {"totalMb": total // 2**20, "availableMb": 0}
        except (ValueError, OSError, AttributeError):
            return {"totalMb": 0, "availableMb": 0}


def gpus() -> list[dict[str, Any]]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return []
    try:
        r = subprocess.run([exe, "--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return []
    return parse_nvidia_smi(r.stdout) if r.returncode == 0 else []


def providers() -> list[str]:
    try:
        import onnxruntime as ort

        return list(ort.get_available_providers())
    except Exception:  # noqa: BLE001 - not installed, or a broken install
        return []


def inference_device(provs: list[str]) -> str:
    return "DirectML" if "DmlExecutionProvider" in provs else "CUDA" if "CUDAExecutionProvider" in provs else "CPU"


_hw: dict[str, Any] = {}
_hw_lock = threading.Lock()


def hardware(refresh: bool = False) -> dict[str, Any]:
    with _hw_lock:
        if refresh or not _hw or time.monotonic() - _hw["_t"] > 300:
            provs = providers()
            _hw.clear()
            _hw.update({"cpuCores": os.cpu_count() or 1, "ram": ram(), "gpus": gpus(), "providers": provs,
                        "inference": inference_device(provs), "_t": time.monotonic()})
        return {k: v for k, v in _hw.items() if k != "_t"}


# --- profiles --------------------------------------------------------------------------------


def _vram(hw: dict[str, Any]) -> int:
    return max((g["vramMb"] for g in hw.get("gpus") or []), default=0)


def _ram_cap(hw: dict[str, Any], per_mb: int) -> int:
    total = (hw.get("ram") or {}).get("totalMb") or 0
    return max(1, total // per_mb) if total else 1


def for_profile(name: str, hw: dict[str, Any], tuned: dict[str, Any] | None = None) -> Perf:
    """What a profile means on this machine."""
    cores = int(hw.get("cpuCores") or 1)
    gpu = hw.get("inference") in ("DirectML", "CUDA")
    ingest_default = 1 if cores <= 4 else 2
    if name == "gentle":
        return Perf(analyses=1, ingests=1, sessions=1, batch=1, threads=max(1, cores // 2))
    if name == "max":
        vram = _vram(hw)
        if gpu:
            n = 3 if vram >= 10_000 else 2 if vram >= 6_000 or not vram else 1
        else:   # on 4 cores two analyses side by side took longer than one after the other (37 vs 31 s)
            n = 2 if cores >= 12 else 1
        n = min(n, _ram_cap(hw, RAM_PER_ANALYSIS_MB))
        ingests = min(MAX_INGESTS, max(2, cores // 4), _ram_cap(hw, RAM_PER_INGEST_MB))
        return Perf(analyses=n, ingests=ingests, sessions=n if gpu else 1, batch=4, threads=0)
    if name == "tuned" and tuned:
        return Perf.from_dict(tuned)
    return Perf(analyses=1, ingests=ingest_default, sessions=1, batch=1, threads=0)


LOWER = {"tuned": "balanced", "max": "balanced", "balanced": "gentle"}


# --- storage ---------------------------------------------------------------------------------

_lock = threading.Lock()
_cache: dict[str, Any] = {}


def _path() -> Path:
    return settings().data_dir / FILE


def load() -> dict[str, Any]:
    p = _path()
    try:
        mtime = p.stat().st_mtime_ns
    except OSError:
        return {"profile": "balanced", "rev": 0}
    if _cache.get("path") == p and _cache.get("mtime") == mtime:
        return json.loads(json.dumps(_cache["data"]))
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError
    except (OSError, ValueError):
        data = {}
    if data.get("profile") not in PROFILES or (data.get("profile") == "tuned" and not data.get("tuned")):
        data["profile"] = "balanced"
    data.setdefault("rev", 0)
    _cache.update(path=p, mtime=mtime, data=data)
    return json.loads(json.dumps(data))


def _save(data: dict[str, Any]) -> dict[str, Any]:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    data["rev"] = int(data.get("rev", 0)) + 1
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(p)
    _cache.clear()
    return data


def now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="seconds")


def set_profile(name: str) -> dict[str, Any]:
    """The user's choice; it also clears an earlier automatic step down."""
    if name not in PROFILES:
        raise ValueError(name)
    with _lock:
        data = load()
        if name == "tuned" and not data.get("tuned"):
            raise LookupError("not tuned yet")
        data["profile"] = name
        data.pop("fallback", None)
        data.pop("cpuOnly", None)
        return _save(data)


def save_tuned(perf: Perf, summary: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        data = load()
        data["tuned"] = {**asdict(perf), "summary": summary, "at": now()}
        data["profile"] = "tuned"
        data.pop("fallback", None)
        data.pop("cpuOnly", None)
        return _save(data)


def effective(hw: dict[str, Any] | None = None) -> tuple[Perf, dict[str, Any]]:
    """The settings the worker uses now, and the stored state they come from."""
    data = load()
    perf = for_profile(data["profile"], hw if hw is not None else hardware(), data.get("tuned"))
    if data.get("cpuOnly"):
        perf = replace(perf, gpu=False, sessions=1, analyses=1)
    try:  # INGEST_PARALLEL in .env still wins (it was there first)
        perf = replace(perf, ingests=max(1, min(MAX_INGESTS, int(os.environ["INGEST_PARALLEL"]))))
    except (KeyError, ValueError):
        pass
    return perf, data


def step_down(rev: int, reason: str) -> dict[str, Any] | None:
    """After an out-of-memory or GPU device error: a lower profile, saved. Returns what changed,
    or None when the settings were already changed since `rev` (another job stepped down first)
    – the caller then just retries with the current ones."""
    with _lock:
        data = load()
        if int(data.get("rev", 0)) != rev:
            return None
        old = data["profile"]
        if old in LOWER:
            data["profile"] = LOWER[old]
            to = data["profile"]
        else:
            data["cpuOnly"] = True
            to = "cpu"
        data["fallback"] = {"at": now(), "from": old, "to": to, "reason": reason[:300]}
        _save(data)
        return data["fallback"]


DEVICE_ERRORS = re.compile(
    r"out of memory|outofmemory|\boom\b|e_outofmemory|8007000e|887a0005|887a0006|887a0007|device (?:was )?removed|device_removed|"
    r"device hung|dxgi_error|d3d12|directml|dmlexecutionprovider|cuda(?:error| error|_error)|cudnn|cublas|failed to allocate|"
    r"bad_alloc|insufficient memory|not enough memory|cannot allocate memory", re.I)


def is_device_error(exc: BaseException) -> bool:
    """Out of (GPU) memory or a lost GPU device: worth one more try with lower settings."""
    if isinstance(exc, MemoryError):
        return True
    return bool(DEVICE_ERRORS.search(f"{type(exc).__name__}: {exc}"))
