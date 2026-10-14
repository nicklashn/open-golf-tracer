"""File storage behind an interface. Local disk now; an S3-compatible backend can implement the
same methods (local_path() would download to a cache, open_write() would upload on close)."""
from __future__ import annotations

import functools
import os
import shutil
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from .config import settings


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
            os.replace(src, dst)
        else:
            shutil.copyfile(src, dst)
        return dst.stat().st_size

    def delete(self, key: str) -> None:
        self.local_path(key).unlink(missing_ok=True)

    def delete_prefix(self, prefix: str) -> None:
        p = self.local_path(prefix)
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.is_file():
            p.unlink()


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
