"""Free disk space: checked before work that writes gigabytes (an upload, its preview, an
export), so a full disk gives a clear "disk_full" instead of half-written files. Not retried:
the user has to make room first (Settings → Storage)."""
from __future__ import annotations

import errno
import shutil

from .config import settings
from .errors import ApiError

GB = 1024 ** 3
# Kept free for Windows and everything else on the disk.
RESERVE = GB
# A preview (1280 px H.264) is a fraction of a phone's 1080p60 original; generous on purpose.
PROXY_SHARE = 0.3
# Bytes per second of exported video, by preset (H.264 at the exporter's settings, with audio).
EXPORT_RATE = {"shorts": 2_500_000, "youtube1080": 3_000_000, "youtube4k": 8_000_000, "original": 5_000_000}
DISK_FULL = "disk_full"


class DiskFull(OSError):
    """Raised by workers; the job fails with error code disk_full and is not retried."""

    def __init__(self, need: int, free: int):
        super().__init__(errno.ENOSPC, f"[{DISK_FULL}] Not enough free disk space: {need / GB:.1f} GB needed, {free / GB:.1f} GB free.")
        self.need, self.free = need, free


def free_bytes() -> int:
    d = settings().data_dir
    d.mkdir(parents=True, exist_ok=True)
    return shutil.disk_usage(d).free


def disk_full(exc: BaseException) -> bool:
    """An OSError that means the disk is full (ENOSPC; Windows ERROR_DISK_FULL / HANDLE_DISK_FULL)."""
    return isinstance(exc, OSError) and (exc.errno == errno.ENOSPC or getattr(exc, "winerror", None) in (39, 112))


def upload_need(size: int, kind: str) -> int:
    return size + (int(size * PROXY_SHARE) if kind == "video" else 0)


def export_need(seconds: float, preset: str) -> int:
    return int(max(1.0, seconds) * EXPORT_RATE.get(preset, EXPORT_RATE["original"])) + 200 * 1024 ** 2


def need_space(need: int, pending: int = 0) -> None:
    """ApiError 507 disk_full unless `need` bytes fit beside `pending` (promised to work under
    way) and the reserve."""
    free = free_bytes()
    if free - pending - RESERVE < need:
        raise ApiError(507, DISK_FULL, "There is not enough free disk space. Free some up under Settings → Storage.",
                       {"need": need, "free": free})


def check_worker(need: int) -> None:
    """need_space for workers: raises DiskFull."""
    free = free_bytes()
    if free - RESERVE < need:
        raise DiskFull(need, free)
