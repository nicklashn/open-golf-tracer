"""ffprobe-based validation: the file must really be a video/audio/image, not just carry the
right extension."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

HDR_TRC = {"arib-std-b67", "smpte2084"}
IMAGE_CODECS = {"png", "mjpeg", "webp", "bmp", "gif", "tiff"}


class ProbeError(ValueError):
    pass


def ffprobe_bin() -> str:
    exe = shutil.which("ffprobe")
    if not exe:
        raise RuntimeError("ffprobe was not found on PATH")
    return exe


def _rotation(st: dict) -> int:
    for sd in st.get("side_data_list", []) or []:
        if "rotation" in sd:
            return int(round(float(sd["rotation"]))) % 360
    tag = (st.get("tags") or {}).get("rotate")
    return int(tag) % 360 if tag else 0


_ISO6709 = re.compile(r"^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)")


def _geo(tags: dict[str, str]) -> dict[str, float] | None:
    """Where the phone was when recording (iPhone: com.apple.quicktime.location.ISO6709,
    Android: location), e.g. "+55.6761+012.5683+010.000/". For golf that is about the tee."""
    raw = tags.get("com.apple.quicktime.location.ISO6709") or tags.get("location") or tags.get("location-eng") or ""
    m = _ISO6709.match(raw.strip())
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
        return None
    geo = {"lat": round(lat, 6), "lon": round(lon, 6)}
    try:
        geo["acc"] = round(float(tags["com.apple.quicktime.location.accuracy.horizontal"]), 1)
    except (KeyError, ValueError):
        pass
    return geo


def probe_file(path: Path) -> dict[str, Any]:
    try:
        out = subprocess.run([ffprobe_bin(), "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
                             capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired as exc:
        raise ProbeError("The file could not be read (timeout).") from exc
    if out.returncode != 0:
        raise ProbeError("The file is not a video, audio or image file we can read.")
    data = json.loads(out.stdout or "{}")
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    v = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = float(fmt.get("duration") or (v or a or {}).get("duration") or 0)
    fmt_name = fmt.get("format_name", "")
    if v is not None and (v.get("codec_name") in IMAGE_CODECS and (duration == 0 or "image2" in fmt_name or "_pipe" in fmt_name)):
        kind = "image"
    elif v is not None:
        kind = "video"
    elif a is not None:
        kind = "audio"
    else:
        raise ProbeError("The file contains neither video nor audio.")
    info: dict[str, Any] = {"kind": kind, "duration": duration, "format": fmt_name, "hasAudio": a is not None,
                            "bitrate": int(fmt.get("bit_rate") or 0)}
    if v is not None:
        w, h = int(v.get("width") or 0), int(v.get("height") or 0)
        rot = _rotation(v)
        if rot in (90, 270):
            w, h = h, w
        fps = 0.0
        for key in ("avg_frame_rate", "r_frame_rate"):
            try:
                f = Fraction(v.get(key) or "0/1")
                if f > 0:
                    fps = float(f)
                    break
            except (ValueError, ZeroDivisionError):
                continue
        trc = v.get("color_transfer", "")
        info.update({"width": w, "height": h, "rotation": rot, "fps": round(fps, 4), "codec": v.get("codec_name", ""),
                     "pix_fmt": v.get("pix_fmt", ""), "hdr": trc in HDR_TRC,
                     "color": {k: v.get(s) for k, s in (("color_primaries", "color_primaries"), ("color_trc", "color_transfer"),
                                                         ("colorspace", "color_space")) if v.get(s) and v.get(s) != "unknown"}})
        if kind == "video" and (w < 16 or h < 16):
            raise ProbeError("The video has invalid dimensions.")
        if kind == "video" and duration <= 0:
            raise ProbeError("The video has no length.")
    tags = {k: str(v) for k, v in (fmt.get("tags") or {}).items()}
    geo = _geo(tags)
    if geo:
        info["geo"] = geo
    # When it was filmed (orders the clips of a round); the phone's local time when it has one.
    recorded = tags.get("com.apple.quicktime.creationdate") or tags.get("creation_time")
    if recorded:
        info["recordedAt"] = recorded[:40]
    if a is not None:
        info["audio"] = {"codec": a.get("codec_name", ""), "channels": a.get("channels", 0), "sample_rate": int(a.get("sample_rate") or 0)}
    return info
