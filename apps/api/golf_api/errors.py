"""Uniform API errors: {"error": {"code", "message", "ref"?, "details"?}}. Codes are stable and
translated in the web app; the message is a Danish fallback."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException


class ApiError(HTTPException):
    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(status_code=status, detail={"code": code, "message": message, "details": details or {}})
        self.code = code


def not_found(what: str = "Ressourcen") -> ApiError:
    return ApiError(404, "not_found", f"{what} was not found.")


def forbidden(msg: str = "You do not have access to this.") -> ApiError:
    return ApiError(403, "forbidden", msg)

