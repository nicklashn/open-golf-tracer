"""Masks anything that looks like a key or token before text reaches a log file or the
diagnostics bundle. The same patterns live in scripts/applog.mjs (the launcher's log file); keep
the two in step (both are tested with the same examples)."""
from __future__ import annotations

import re
from collections.abc import Iterable

MASK = "[redacted]"

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # Authorization: Bearer … / Basic …
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 " + MASK),
    # key=value / "key": "value" for names that hold secrets
    (re.compile(r"(?i)((?:x-)?api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret[_-]?key|internal[_-]?token"
                r"|password|secret|token|authorization)([\"']?\s*[:=]\s*[\"']?)(?!bearer\b|basic\b)([^\s\"'&,;}]{8,})"), r"\1\2" + MASK),
    # OAuth codes and state in a query string
    (re.compile(r"([?&](?:code|state|key)=)[^&\s\"']+"), r"\1" + MASK),
    # Provider keys: OpenAI (sk-, sk-proj-), Anthropic (sk-ant-), GitHub, Google, Hugging Face
    (re.compile(r"\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{20,})"), MASK),
    # JWTs (ChatGPT access / ID tokens)
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}"), MASK),
    # Signed media URLs (/api/m/<payload>.<mac>)
    (re.compile(r"(/m/)[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"), r"\1" + MASK),
]


def redact(text: str, secrets: Iterable[str] = ()) -> str:
    """`text` with known secret values (`secrets`, e.g. the configured keys) and anything shaped
    like a key, bearer token or JWT replaced by [redacted]."""
    for s in sorted({s for s in secrets if s and len(s) >= 6}, key=len, reverse=True):
        text = text.replace(s, MASK)
    for pat, repl in _PATTERNS:
        text = pat.sub(repl, text)
    return text
