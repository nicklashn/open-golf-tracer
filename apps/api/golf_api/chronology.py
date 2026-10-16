"""When a clip was filmed, and the order of a round's clips.

A clip's time (probe "recordedAt", with "recordedAtSource") comes from the first source that has one:
  1. metadata: com.apple.quicktime.creationdate (local time with its offset), else creation_time (UTC).
  2. filename: PXL_20261016_101523123 (UTC), VID_/IMG_20261016_101523, 20261016_101523 and
     2026-10-16 10.15.23 (local time). WhatsApp (VID-20261016-WA0003) and GoPro names carry no time;
     they only sort (by day and number, by recording and chapter).
  3. file: the file's modified time in the browser (weak: copying a file changes it).
Dates before 2005 (unset clocks, the 1904/1970 epochs) or in the future are ignored.

The order follows the rules of packages/compose/src/chronology.ts (keep both, and their tests, in step):
GoPro chapters share their recording's earliest time and stay together; every clip with a sure time
(metadata or filename) -> by time; no sure time and at least two clips on a known hole -> by hole,
starting after the biggest gap (a round from hole 10 wraps 18 -> 1), clips without a hole last;
otherwise clips with a time by time, then the rest. Ties and untimed clips by file name.
"""
from __future__ import annotations

import datetime as dt
import math
import re
from typing import Any

EARLIEST = dt.datetime(2005, 1, 1, tzinfo=dt.UTC)
SOURCES = ("metadata", "filename", "file")


def _plausible(t: dt.datetime, now: dt.datetime | None = None) -> bool:
    now = now or dt.datetime.now(dt.UTC)
    return EARLIEST <= t <= now + dt.timedelta(days=1)


def _iso(t: dt.datetime) -> str:
    return t.isoformat(timespec="milliseconds" if t.microsecond else "seconds")


def parse_time(s: str | None) -> dt.datetime | None:
    """An ISO 8601 time; without an offset it is local time."""
    if not s:
        return None
    try:
        t = dt.datetime.fromisoformat(s.strip())
    except ValueError:
        return None
    return t if t.tzinfo else t.astimezone()


def epoch(s: str | None) -> float | None:
    t = parse_time(s)
    return t.timestamp() if t else None


def metadata_time(tags: dict[str, str], now: dt.datetime | None = None) -> str | None:
    """Apple's creationdate keeps the phone's local offset; creation_time is UTC (a missing zone means UTC)."""
    apple = parse_time(tags.get("com.apple.quicktime.creationdate"))
    if apple and _plausible(apple, now):
        return _iso(apple)
    raw = (tags.get("creation_time") or "").strip()
    try:
        t = dt.datetime.fromisoformat(raw) if raw else None
    except ValueError:
        t = None
    if t is None:
        return None
    t = t if t.tzinfo else t.replace(tzinfo=dt.UTC)
    return _iso(t) if _plausible(t, now) else None


_NAME_TIME = re.compile(r"^(?:(PXL|VID|IMG)[_-])?(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(\d{3})?(?!\d)", re.I)
_NAME_DASHED = re.compile(r"^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})(?!\d)")


def filename_time(name: str, now: dt.datetime | None = None) -> str | None:
    """The time in a camera's file name. Pixel names are UTC, the others local time."""
    m = _NAME_TIME.match(name)
    utc = False
    if m:
        utc = (m.group(1) or "").upper() == "PXL"
        parts = [int(x) for x in m.groups()[1:7]]
        ms = int(m.group(8) or 0)
    else:
        m = _NAME_DASHED.match(name)
        if not m:
            return None
        parts = [int(x) for x in m.groups()]
        ms = 0
    try:
        t = dt.datetime(*parts, ms * 1000)  # type: ignore[misc]
    except ValueError:
        return None
    t = t.replace(tzinfo=dt.UTC) if utc else t.astimezone()
    return _iso(t) if _plausible(t, now) else None


def file_time(last_modified_ms: float | None, now: dt.datetime | None = None) -> str | None:
    if not last_modified_ms or not math.isfinite(last_modified_ms):
        return None
    try:
        t = dt.datetime.fromtimestamp(last_modified_ms / 1000, dt.UTC)
    except (OverflowError, OSError, ValueError):
        return None
    return _iso(t) if _plausible(t, now) else None


def settle(info: dict[str, Any], filename: str, last_modified_ms: float | None) -> dict[str, Any]:
    """Completes a probe's recordedAt from the file name or the file's modified time."""
    if info.get("recordedAt"):
        info.setdefault("recordedAtSource", "metadata")
        return info
    for source, value in (("filename", filename_time(filename)), ("file", file_time(last_modified_ms))):
        if value:
            info["recordedAt"], info["recordedAtSource"] = value, source
            return info
    info.pop("recordedAtSource", None)
    return info


# --- order -------------------------------------------------------------------------------------

_GOPRO = re.compile(r"^(?:GOPR(\d{4})|G[PHX](\d{2})(\d{4}))(?!\d)", re.I)


def gopro(name: str) -> tuple[int, int] | None:
    """(recording, chapter) of a GoPro file; GOPR0123 is chapter 0, GP010123 the next."""
    m = _GOPRO.match(name)
    if not m:
        return None
    return (int(m.group(1)), 0) if m.group(1) else (int(m.group(3)), int(m.group(2)))


def name_key(name: str) -> str:
    g = gopro(name)
    base = f"gopro {g[0]} {g[1]}" if g else name
    return re.sub(r"\d+", lambda d: (d.group().lstrip("0") or "0").rjust(20, "0"), base.lower())


def time_of(m: dict[str, Any]) -> float | None:
    return epoch(m.get("recordedAt"))


def is_sure(m: dict[str, Any]) -> bool:
    return time_of(m) is not None and m.get("recordedAtSource") != "file"


def hole_of(m: dict[str, Any]) -> int | None:
    h = str(((m.get("place") or {}).get("hole")) or "")
    return int(h) if h.isdigit() and int(h) > 0 else None


def _by_time(media: list[dict[str, Any]]):
    first: dict[int, float] = {}
    for m in media:
        g, t = gopro(m.get("name", "")), time_of(m)
        if g and t is not None:
            first[g[0]] = min(t, first.get(g[0], t))

    def key(m: dict[str, Any]) -> tuple[float, str]:
        g = gopro(m.get("name", ""))
        t = first.get(g[0]) if g else None
        if t is None:
            t = time_of(m)
        return (math.inf if t is None else t, name_key(m.get("name", "")))
    return key


def by_hole(media: list[dict[str, Any]]) -> list[dict[str, Any]]:
    time = _by_time(media)
    holes = sorted({h for h in map(hole_of, media) if h is not None})
    if not holes:
        return sorted(media, key=time)
    n = max(18, *holes)
    start, gap = holes[0], holes[0] + n - holes[-1]
    for a, b in zip(holes, holes[1:], strict=False):
        if b - a > gap:
            start, gap = b, b - a

    def pos(m: dict[str, Any]) -> int:
        h = hole_of(m)
        return n if h is None else (h - start + n) % n
    return sorted(media, key=lambda m: (pos(m), *time(m)))


def round_order(media: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not any(map(is_sure, media)) and sum(hole_of(m) is not None for m in media) >= 2:
        return by_hole(media)
    return sorted(media, key=_by_time(media))


def clip_slot(doc: dict[str, Any], media_id: str) -> int:
    """Where a new clip of media_id goes: before the first clip that comes later in the round order."""
    clips = doc.get("clips", [])
    all_media = doc.get("media", {})
    ids = {c.get("mediaId") for c in clips} | {media_id}
    media = [m for mid, m in all_media.items() if mid in ids and m.get("kind", "video") == "video"]
    rank = {m["id"]: i for i, m in enumerate(round_order(media))}
    mine = rank.get(media_id)
    if mine is None:
        return len(clips)
    return next((i for i, c in enumerate(clips) if rank.get(c.get("mediaId"), -1) > mine), len(clips))
