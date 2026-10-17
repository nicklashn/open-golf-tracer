"""FastAPI application: routers under /api, security headers, request ids, uniform errors."""
from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import ipaddress
import logging
import secrets
import sys
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import logging_setup, maintenance
from .config import settings
from .logging_setup import request_id
from .routes import account, autovideo, chatgpt, disk, exports, geo, internal, jobs, media, misc, performance, projects, uploads

log = logging.getLogger("golf.api")

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def cross_site(request: Request) -> bool:
    """True for a write sent by another web site (a page in the user's browser posting to
    localhost). There is no login, so this is what keeps other sites from editing projects."""
    site = request.headers.get("sec-fetch-site")
    if site is not None:
        return site not in ("same-origin", "none")
    origin = request.headers.get("origin")
    if not origin:
        return False      # not a browser (worker, exporter, curl, tests)
    host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
    return origin.split("://", 1)[-1].rstrip("/") != host.split(",")[0].strip()


def foreign_host(request: Request) -> bool:
    """True when the page was opened under a host name we don't know. A web site can point its own
    name at 127.0.0.1 (DNS rebinding) and then read the API as same-origin; it can't fake an IP
    address or "localhost" as the name, so only those and ALLOWED_HOSTS are accepted."""
    raw = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip().lower()
    if not raw:
        return False      # not HTTP/1.1 from a browser
    name = raw[1:].split("]")[0] if raw.startswith("[") else raw.rsplit(":", 1)[0] if raw.count(":") == 1 else raw
    if name == "localhost" or name.endswith(".localhost"):
        return False
    with contextlib.suppress(ValueError):
        ipaddress.ip_address(name)
        return False
    return name not in {h.strip().lower() for h in settings().allowed_hosts.split(",") if h.strip()}


KEEP_BACKUPS = 5


class NewerDataError(RuntimeError):
    """The database was written by a newer version of the app (an older one was installed over it)."""


def _alembic_config():
    from alembic.config import Config

    from .config import API_DIR

    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    return cfg


def _backup_sqlite(rev: str) -> Path | None:
    """A copy of the database before migrations change it: data/backups/db-<rev>-<date>.sqlite
    (the last KEEP_BACKUPS are kept). VACUUM INTO writes a consistent copy even while the
    worker or exporter has the file open."""
    from .db import engine

    eng = engine()
    if eng.dialect.name != "sqlite" or not eng.url.database or eng.url.database == ":memory:":
        return None
    folder = settings().data_dir / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = folder / f"db-{rev}-{stamp}.sqlite"
    n = 1
    while out.exists():
        n += 1
        out = folder / f"db-{rev}-{stamp}-{n}.sqlite"
    with eng.connect() as conn:
        conn.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.exec_driver_sql("VACUUM INTO ?", (str(out),))
    for old in sorted(folder.glob("db-*.sqlite"), key=lambda f: f.stat().st_mtime)[:-KEEP_BACKUPS]:
        with contextlib.suppress(OSError):
            old.unlink()
    log.info("database backed up to %s before migrating from %s", out, rev)
    return out


def migrate() -> None:
    """Apply Alembic migrations (idempotent). A database that needs migrating is backed up first;
    one from a newer version stops with NewerDataError instead of a generic failure."""
    from alembic import command
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory

    from .db import engine

    cfg = _alembic_config()
    script = ScriptDirectory.from_config(cfg)
    head = script.get_current_head()
    with engine().connect() as conn:
        current = MigrationContext.configure(conn).get_current_revision()
    if current is not None and current != head:
        known = {r.revision for r in script.walk_revisions()}
        if current not in known:
            raise NewerDataError(f"{NEWER_DATA}: The data in {settings().data_dir} is from a newer version of Open Golf Tracer "
                                 f"(database revision {current}, this version knows up to {head}). Install the newest version.")
        _backup_sqlite(current)
    command.upgrade(cfg, "head")


# Printed (and matched by scripts/dev.mjs) when an older app meets newer data.
NEWER_DATA = "DATA_FROM_NEWER_VERSION"


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    logging_setup.setup(settings().log_level)
    try:
        migrate()
    except NewerDataError as exc:
        print(str(exc), file=sys.stderr, flush=True)
        raise

    async def housekeeping():
        while True:
            try:
                await asyncio.to_thread(maintenance.run_once)
            except Exception:  # never let housekeeping kill the API
                log.exception("vedligeholdelse fejlede")
            await asyncio.sleep(30)

    task = asyncio.create_task(housekeeping())
    yield
    task.cancel()


def create_app() -> FastAPI:
    app = FastAPI(title="Open Golf Tracer API", version="0.1.0", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json",
                  redoc_url=None)

    @app.middleware("http")
    async def context(request: Request, call_next):
        if foreign_host(request):
            return JSONResponse({"error": {"code": "unknown_host", "message": "Open the app via localhost or add the name to ALLOWED_HOSTS."}},
                                status_code=403)
        if request.method not in SAFE_METHODS and cross_site(request):
            return JSONResponse({"error": {"code": "cross_site", "message": "Requests from other web sites are not allowed."}},
                                status_code=403)
        rid = request.headers.get("x-request-id") or secrets.token_hex(6)
        token = request_id.set(rid[:32])
        t0 = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            request_id.reset(token)
        ms = round((time.perf_counter() - t0) * 1000, 1)
        response.headers["X-Request-Id"] = rid[:32]
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if not settings().is_dev:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        if request.url.path.startswith("/api/") and "/m/" not in request.url.path:
            response.headers.setdefault("Cache-Control", "no-store")
        if not request.url.path.startswith(("/api/m/", "/api/events", "/api/health", "/api/internal/jobs/claim", "/api/internal/jobs/")):
            log.info("%s %s", request.method, request.url.path,
                     extra={"path": request.url.path, "method": request.method, "status": response.status_code, "ms": ms})
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "http_error", "message": str(exc.detail)}
        return JSONResponse({"error": detail}, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        errs = [{"field": ".".join(str(p) for p in e.get("loc", [])[1:]), "message": e.get("msg", "")} for e in exc.errors()]
        return JSONResponse({"error": {"code": "validation", "message": "Some fields are not filled in correctly.", "details": {"fields": errs}}},
                            status_code=422)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        ref = secrets.token_hex(4)
        log.exception("unexpected error %s (%s %s)", ref, request.method, request.url.path)
        return JSONResponse({"error": {"code": "server_error", "message": "Something went wrong on our side. Try again in a moment.", "ref": ref}},
                            status_code=500)

    for r in (account, projects, uploads, media, jobs, autovideo, chatgpt, exports, geo, internal, performance, disk, misc):
        app.include_router(r.router, prefix="/api")
    return app


app = create_app()
