"""File storage behind an interface. Local disk now; an S3-compatible backend can implement the
same methods (local_path() would download to a cache, open_write() would upload on close)."""
from __future__ import annotations

import functools
import json
import logging
import os
import shutil
import threading
import time
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from .config import settings

log = logging.getLogger("golf.storage")


class StorageError(ValueError):
    pass


def safe_key(key: str) -> str:
    """Keys are relative POSIX paths without '..', absolute parts or odd characters."""
    p = PurePosixPath(key)
    if not p.parts or p.is_absolute() or any(part in ("", ".", "..") for part in p.parts) or "\\" in key or "\x00" in key:
        raise StorageError(f"invalid key: {key!r}")
    return str(p)


class Storage:
    def local_path(self, key: str) -> Path: ...
    def exists(self, key: str) -> bool: ...
    def size(self, key: str) -> int: ...
    def open_read(self, key: str) -> BinaryIO: ...
    def put_file(self, key: str, src: Path, move: bool = False) -> int: ...
    def delete(self, key: str) -> None: ...
    def delete_prefix(self, prefix: str) -> None: ...


class LocalStorage(Storage):
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def local_path(self, key: str) -> Path:
        p = (self.root / safe_key(key)).resolve()
        if self.root not in p.parents and p != self.root:
            raise StorageError("sti uden for lageret")
        return p

    def exists(self, key: str) -> bool:
        return self.local_path(key).is_file()

    def size(self, key: str) -> int:
        return self.local_path(key).stat().st_size

    def open_read(self, key: str) -> BinaryIO:
        return self.local_path(key).open("rb")

    def put_file(self, key: str, src: Path, move: bool = False) -> int:
        dst = self.local_path(key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        if move:
            retry_locked(lambda: os.replace(src, dst))
        else:
            shutil.copyfile(src, dst)
        return dst.stat().st_size

    def delete(self, key: str) -> None:
        p = self.local_path(key)
        try:
            retry_locked(lambda: p.unlink(missing_ok=True))
        except OSError as exc:
            log.warning("could not delete %s now (%s); housekeeping tries again", key, exc)
            _remember(key)

    def delete_prefix(self, prefix: str) -> None:
        """Deletes a folder. A file still open somewhere (Windows: a video the worker is reading,
        antivirus) is retried briefly, then left to housekeeping (sweep_pending), never hidden."""
        p = self.local_path(prefix)
        if not p.exists():
            return
        try:
            retry_locked(lambda: shutil.rmtree(p) if p.is_dir() else p.unlink(missing_ok=True), attempts=10)
        except OSError as exc:
            log.warning("could not delete %s now (%s); housekeeping tries again", prefix, exc)
            _remember(prefix)


def retry_locked(fn: Callable[[], object], attempts: int = 20, wait: float = 0.05) -> None:
    """Runs a file operation, retrying while Windows reports the file in use (an antivirus
    scanning a fresh file, a reader closing it) – like performance._save."""
    for attempt in range(attempts):
        try:
            fn()
            return
        except FileNotFoundError:
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(wait * (1 + attempt))
        except OSError as exc:    # rmtree on Windows: "directory not empty" while a file is still open
            if getattr(exc, "winerror", None) not in (5, 32, 145) or attempt == attempts - 1:
                raise
            time.sleep(wait * (1 + attempt))


_pending_lock = threading.Lock()


def _pending_file() -> Path:
    return settings().data_dir / "pending-deletes.json"


def _read_pending() -> list[str]:
    try:
        data = json.loads(_pending_file().read_text(encoding="utf-8"))
        return [k for k in data if isinstance(k, str)] if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _write_pending(keys: list[str]) -> None:
    f = _pending_file()
    tmp = f.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(sorted(set(keys))), encoding="utf-8")
    retry_locked(lambda: tmp.replace(f))


def _remember(key: str) -> None:
    with _pending_lock:
        _write_pending([*_read_pending(), key])


def pending_deletes() -> list[str]:
    with _pending_lock:
        return _read_pending()


def sweep_pending() -> int:
    """Deletes what could not be deleted earlier (housekeeping). Returns how many are done."""
    with _pending_lock:
        keys = _read_pending()
        if not keys:
            return 0
        left = []
        for key in keys:
            try:
                p = storage().local_path(key)
                if p.is_dir():
                    shutil.rmtree(p)
                else:
                    p.unlink(missing_ok=True)
            except StorageError:
                continue
            except OSError:
                left.append(key)
        _write_pending(left)
        return len(keys) - len(left)


@functools.cache
def storage() -> Storage:
    return LocalStorage(settings().data_dir / "storage")


def tmp_dir() -> Path:
    d = settings().data_dir / "tmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


def user_prefix(user_id: str) -> str:
    return f"users/{safe_key(user_id)}"


def media_prefix(user_id: str, media_id: str) -> str:
    return f"{user_prefix(user_id)}/media/{safe_key(media_id)}"
