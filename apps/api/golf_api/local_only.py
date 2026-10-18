"""Is a request from a browser on this PC? For the endpoints that open a window on the PC that runs
the app (the exports folder, the data folder): from another device it would open a window nobody
sees, and nobody else should be able to make this PC run a file manager."""
from __future__ import annotations

import ipaddress

from fastapi import Request


def _loopback(host: str | None) -> bool:
    try:
        return host is not None and ipaddress.ip_address(host.strip().strip("[]")).is_loopback
    except ValueError:
        return host is not None and host.strip() == "localhost"


def local_request(request: Request) -> bool:
    """True only for a browser on this PC: the connection comes from the loopback address, and so
    does every hop the web app's proxy names (it adds the browser's address to X-Forwarded-For).
    A client can put 127.0.0.1 in X-Forwarded-For itself, but not remove the address the proxy
    appends, so every hop must be loopback, not just the first one."""
    if not _loopback(request.client.host if request.client else None):
        return False
    hops = [h for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    return all(_loopback(h) for h in hops)
