"""Keeps Windows from going to sleep while jobs run (an analysis of a round takes long enough for
the idle timer to put the PC to sleep halfway). Only idle sleep is held off: closing the lid or
choosing Sleep still works, and the job queue copes with that (leases in golf_api.jobs).

SetThreadExecutionState is per thread, so one thread owns the request: set while any job runs,
released when the last one ends. Elsewhere this does nothing."""
from __future__ import annotations

import contextlib
import logging
import sys
import threading
from collections.abc import Iterator

log = logging.getLogger("golf.worker")

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001

_lock = threading.Lock()
_changed = threading.Condition(_lock)
_running = 0
_thread: threading.Thread | None = None


def _set(busy: bool) -> None:
    import ctypes

    flags = ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if busy else 0)
    if not ctypes.windll.kernel32.SetThreadExecutionState(flags):  # type: ignore[attr-defined]
        log.debug("SetThreadExecutionState(%#x) failed", flags)


def _owner() -> None:
    held = False
    while True:
        with _changed:
            while (_running > 0) == held:
                _changed.wait()
            held = _running > 0
        try:
            _set(held)
        except Exception as exc:  # noqa: BLE001 - staying awake is a convenience
            log.debug("keep awake: %s", exc)


@contextlib.contextmanager
def held() -> Iterator[None]:
    """Hold the PC awake for the duration of a job."""
    global _running, _thread
    if sys.platform != "win32":
        yield
        return
    with _changed:
        if _thread is None:
            _thread = threading.Thread(target=_owner, name="keep-awake", daemon=True)
            _thread.start()
        _running += 1
        _changed.notify_all()
    try:
        yield
    finally:
        with _changed:
            _running -= 1
            _changed.notify_all()
