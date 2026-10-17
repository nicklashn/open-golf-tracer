"""Secrets at rest: the AI key and the ChatGPT tokens in the database.

On Windows they are encrypted with DPAPI (CryptProtectData, bound to the Windows user account),
so a copy of data/open-golf-tracer.db on its own, a backup or another user on the PC can't read
them. Stored values carry a "dpapi:" prefix; plaintext from older versions still reads and is
encrypted on the next start (`migrate`). On macOS/Linux there is no equivalent without extra
dependencies, so the values stay plaintext and are protected only by the file permissions of the
data folder (see README.md, "Security and privacy").

A value that can't be decrypted (the database was copied to another PC or Windows user) reads as
"" - the key or sign-in simply has to be entered again.
"""
from __future__ import annotations

import base64
import logging
import sys

from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator

log = logging.getLogger("golf.api")

PREFIX = "dpapi:"
_ENTROPY = b"open-golf-tracer secrets v1"


def available() -> bool:
    return sys.platform == "win32"


if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    class _Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    _crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _BlobP = ctypes.POINTER(_Blob)
    _crypt32.CryptProtectData.argtypes = [_BlobP, wintypes.LPCWSTR, _BlobP, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, _BlobP]
    _crypt32.CryptProtectData.restype = wintypes.BOOL
    _crypt32.CryptUnprotectData.argtypes = [_BlobP, ctypes.c_void_p, _BlobP, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, _BlobP]
    _crypt32.CryptUnprotectData.restype = wintypes.BOOL
    _kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    _kernel32.LocalFree.restype = ctypes.c_void_p
    _UI_FORBIDDEN = 0x1

    def _blob(data: bytes) -> tuple[_Blob, ctypes.Array]:
        buf = ctypes.create_string_buffer(data, len(data))
        return _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf

    def _call(fn, data: bytes) -> bytes:
        src, _keep = _blob(data)
        ent, _keep2 = _blob(_ENTROPY)
        out = _Blob()
        if not fn(ctypes.byref(src), None, ctypes.byref(ent), None, None, _UI_FORBIDDEN, ctypes.byref(out)):
            raise OSError(ctypes.get_last_error(), "DPAPI call failed")
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            _kernel32.LocalFree(out.pbData)

    def _protect(data: bytes) -> bytes:
        return _call(_crypt32.CryptProtectData, data)

    def _unprotect(data: bytes) -> bytes:
        return _call(_crypt32.CryptUnprotectData, data)

else:
    def _protect(data: bytes) -> bytes:
        raise OSError("DPAPI is only available on Windows")

    def _unprotect(data: bytes) -> bytes:
        raise OSError("DPAPI is only available on Windows")


def seal(value: str) -> str:
    """The value as stored: encrypted on Windows, unchanged elsewhere (and for "")."""
    if not value or value.startswith(PREFIX) or not available():
        return value
    try:
        return PREFIX + base64.b64encode(_protect(value.encode("utf-8"))).decode("ascii")
    except Exception:  # never lose the value: keep it as before (plaintext)
        log.warning("DPAPI encryption failed; the secret is stored unencrypted")
        return value


def unseal(value: str) -> str:
    if not value or not value.startswith(PREFIX):
        return value      # plaintext (older version, or not Windows)
    try:
        return _unprotect(base64.b64decode(value[len(PREFIX):])).decode("utf-8")
    except Exception:  # another PC/user, or a damaged value: treat as not set
        log.warning("a stored secret could not be decrypted (database from another PC or Windows user?); it must be entered again")
        return ""


class SecretText(TypeDecorator):
    """A Text column that holds a secret: sealed on write, unsealed on read."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        return seal(value) if isinstance(value, str) else value

    def process_result_value(self, value, dialect):
        return unseal(value) if isinstance(value, str) else value


def migrate() -> int:
    """Encrypt plaintext secrets left by an older version (Windows only). Returns how many."""
    if not available():
        return 0
    from sqlalchemy import text

    from .db import session_scope

    n = 0
    with session_scope() as db:
        for table, cols in (("ai_settings", ("api_key",)), ("chatgpt_accounts", ("access_token", "refresh_token"))):
            for col in cols:
                rows = db.execute(text(f"SELECT user_id, {col} FROM {table} WHERE {col} != '' AND {col} NOT LIKE :p"),
                                  {"p": PREFIX + "%"}).all()
                for uid, val in rows:
                    db.execute(text(f"UPDATE {table} SET {col} = :v WHERE user_id = :u"), {"v": seal(val), "u": uid})
                    n += 1
    if n:
        log.info("encrypted %d stored secret(s) with DPAPI", n)
    return n
