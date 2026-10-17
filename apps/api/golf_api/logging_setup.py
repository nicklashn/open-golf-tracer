"""Structured (JSON) logging with the request id attached. Messages and tracebacks pass through
redact() first, so a key or token that ends up in an error message never reaches the log."""
from __future__ import annotations

import contextvars
import json
import logging
import sys
import time

from .redact import redact

request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)), "level": record.levelname,
               "logger": record.name, "msg": redact(record.getMessage()), "rid": request_id.get()}
        for k in ("path", "method", "status", "ms", "user"):
            if hasattr(record, k):
                out[k] = getattr(record, k)
        if record.exc_info:
            out["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(out, ensure_ascii=False)


def setup(level: str = "INFO") -> None:
    root = logging.getLogger()
    if any(isinstance(h.formatter, JsonFormatter) for h in root.handlers):
        return
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(JsonFormatter())
    root.handlers = [h]
    root.setLevel(level)
    for noisy in ("uvicorn.access", "httpx", "multipart", "alembic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
