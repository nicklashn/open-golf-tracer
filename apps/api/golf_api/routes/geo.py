"""OpenStreetMap lookups for the course map: golf features around a point (Overpass) and
place search (Nominatim). Results are cached on disk; both services ask for light use and an
identifying User-Agent, and their data is ODbL (attribution "© OpenStreetMap")."""
from __future__ import annotations

import hashlib
import json
import math
import ssl
import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Query

from ..config import settings
from ..deps import current_user
from ..errors import ApiError
from ..models import User

router = APIRouter(tags=["geo"])

# Public Overpass servers are often busy (504 "Dispatcher"), so try several, twice.
OVERPASS = ("https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter")
NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "OpenGolfTracer/0.1 (+https://github.com/nicklashn/open-golf-tracer)"
CACHE_DAYS = 30

# OSM tags -> map feature kind (drawn in this order of precedence when tags overlap).
_GOLF_KIND = {"fairway": "fairway", "green": "green", "tee": "tee", "bunker": "bunker", "rough": "rough",
              "water_hazard": "water", "lateral_water_hazard": "water", "driving_range": "fairway"}


def _client() -> httpx.Client:
    try:  # the OS certificate store: some PCs intercept HTTPS (antivirus)
        import truststore

        verify: Any = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except ImportError:
        verify = True
    return httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=45, verify=verify)


def _cached(kind: str, key: str, fetch) -> Any:
    folder = settings().data_dir / "cache" / "osm"
    folder.mkdir(parents=True, exist_ok=True)
    f = folder / f"{kind}_{hashlib.sha1(key.encode()).hexdigest()[:16]}.json"
    if f.exists() and time.time() - f.stat().st_mtime < CACHE_DAYS * 86400:
        return json.loads(f.read_text(encoding="utf-8"))
    data = fetch()
    f.write_text(json.dumps(data), encoding="utf-8")
    return data


def _kind(tags: dict[str, str]) -> str | None:
    if tags.get("golf") in _GOLF_KIND:
        return _GOLF_KIND[tags["golf"]]
    nat = tags.get("natural")
    if nat == "water" or tags.get("water"):
        return "water"
    if nat == "sand":
        return "bunker"
    if nat == "wood" or tags.get("landuse") == "forest":
        return "woods"
    return None


def _ring(geom: list[dict]) -> list[list[float]]:
    return [[round(p["lat"], 7), round(p["lon"], 7)] for p in geom if "lat" in p]


def course_features(lat: float, lon: float, radius: int) -> dict[str, Any]:
    q = f"""[out:json][timeout:30];
(
  way["golf"](around:{radius},{lat},{lon});
  relation["golf"](around:{radius},{lat},{lon});
  way["natural"~"^(water|wood|sand)$"](around:{radius},{lat},{lon});
  relation["natural"~"^(water|wood)$"](around:{radius},{lat},{lon});
  way["landuse"="forest"](around:{radius},{lat},{lon});
  way["leisure"="golf_course"](around:{radius},{lat},{lon});
  relation["leisure"="golf_course"](around:{radius},{lat},{lon});
);
out geom;"""
    last: Exception | None = None
    elements: list[dict] | None = None
    with _client() as c:
        for attempt in range(2):
            for url in OVERPASS:
                try:
                    r = c.post(url, data={"data": q})
                    r.raise_for_status()
                    elements = r.json().get("elements", [])
                    break
                except (httpx.HTTPError, ValueError) as exc:
                    last = exc
            if elements is not None:
                break
            time.sleep(2 + 3 * attempt)
    if elements is None:
        raise ApiError(502, "osm_unavailable", "Map data could not be fetched from OpenStreetMap right now. Try again in a moment.",
                       {"error": repr(last)[:200]})

    features: list[dict[str, Any]] = []
    holes: list[dict[str, Any]] = []
    course = ""
    for el in elements:
        tags = el.get("tags") or {}
        if tags.get("leisure") == "golf_course":
            course = course or tags.get("name", "")
            continue
        if tags.get("golf") == "hole" and el.get("geometry"):
            holes.append({"ref": tags.get("ref", ""), "par": tags.get("par", ""), "name": tags.get("name", ""),
                          "line": _ring(el["geometry"])})
            continue
        kind = _kind(tags)
        if not kind:
            continue
        if el["type"] == "way" and el.get("geometry"):
            ring = _ring(el["geometry"])
            if len(ring) >= 3:
                features.append({"k": kind, "ring": ring})
        elif el["type"] == "relation":
            for m in el.get("members", []):
                if m.get("role") == "outer" and m.get("geometry"):
                    ring = _ring(m["geometry"])
                    if len(ring) >= 3:
                        features.append({"k": kind, "ring": ring})
    return {"course": course, "features": features, "holes": holes}


COURSE_FETCH_M = 1600   # one fetch covers a whole course, so a round needs one Overpass call


def _metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    x, y = _local(a, [b[0], b[1]])
    return math.hypot(x, y)


def cached_course(lat: float, lon: float, radius: int = 900) -> dict[str, Any]:
    """Golf features within `radius` of a point. Reuses any cached fetch that covers the whole
    circle (the public Overpass servers are slow and often busy), else fetches a wide area."""
    folder = settings().data_dir / "cache" / "osm"
    folder.mkdir(parents=True, exist_ok=True)
    index_file = folder / "course_index.json"
    try:
        index = json.loads(index_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = []
    now = time.time()
    for e in index:
        f = folder / e["file"]
        if now - e["t"] < CACHE_DAYS * 86400 and f.exists() and _metres((e["lat"], e["lon"]), (lat, lon)) + radius <= e["r"]:
            return json.loads(f.read_text(encoding="utf-8"))
    la, lo = round(lat, 4), round(lon, 4)
    r = max(COURSE_FETCH_M, int(math.ceil(radius / 100) * 100) + 150)
    data = course_features(la, lo, r)
    name = f"course_{hashlib.sha1(f'{la},{lo},{r}'.encode()).hexdigest()[:16]}.json"
    (folder / name).write_text(json.dumps(data), encoding="utf-8")
    index = [e for e in index if e.get("file") != name] + [{"lat": la, "lon": lo, "r": r, "file": name, "t": now}]
    index_file.write_text(json.dumps(index), encoding="utf-8")
    return data


@router.get("/geo/course")
def course(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180), radius: int = Query(900, ge=100, le=2000),
           _: User = Depends(current_user)):
    return cached_course(lat, lon, radius)


HOLE_MATCH_M = 60   # further than this from every hole's centre line: not on a hole
GREEN_END_M = 25    # this close to a hole's end counts as by its green
TEE_START_M = 15    # this close to a hole's start counts as on its tee
TEE_PREFERENCE_M = 15  # a tee may be this much further away than the green and still win
TEE_CLUSTER_M = 40  # other tees this close make the hole ambiguous


def _local(o: tuple[float, float], p: list[float]) -> tuple[float, float]:
    r = 6371008.8
    return math.radians(p[1] - o[1]) * r * math.cos(math.radians(o[0])), math.radians(p[0] - o[0]) * r


def _along(o: tuple[float, float], line: list[list[float]]) -> tuple[float, float, float]:
    """Distance from o to the hole's centre line, metres from the tee along it, and its length."""
    pts = [_local(o, q) for q in line]
    best, at, acc = 1e12, 0.0, 0.0
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        dx, dy = bx - ax, by - ay
        seg = math.hypot(dx, dy) or 1e-9
        t = max(0.0, min(1.0, (-ax * dx - ay * dy) / seg ** 2))
        d = math.hypot(ax + t * dx, ay + t * dy)
        if d < best:
            best, at = d, acc + t * seg
        acc += seg
    return best, at, acc


def place_at(lat: float, lon: float, course: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Course, hole and position on it for a point (where the phone recorded a video). Matching
    the whole tee-to-green line works for tee shots and for shots from the fairway alike."""
    data = course if course is not None else cached_course(lat, lon)
    if not data.get("features") and not data.get("holes"):
        return None
    cands = []
    for h in data.get("holes", []):
        if not h.get("ref") or len(h.get("line", [])) < 2:
            continue
        d, s, length = _along((lat, lon), h["line"])
        cands.append((d, s, length, h))
    best = min(cands, key=lambda c: c[0], default=None)
    if best and best[2] - best[1] < GREEN_END_M:
        # By a green: the next hole's tee is usually right there, and people film tee shots,
        # not putts – so a tee about as close as the green wins.
        tee = min((c for c in cands if c[1] < TEE_START_M and c[0] <= best[0] + TEE_PREFERENCE_M), key=lambda c: c[0], default=None)
        if tee is not None:
            best = tee
    out: dict[str, Any] = {"course": data.get("course", "")[:80], "hole": "", "par": None, "fromTee": None, "toGreen": None, "line": []}
    if best and best[0] <= HOLE_MATCH_M:
        if best[1] < TEE_START_M:
            # On a tee. Tees cluster (7 and 17 can share a corner of the course), and the wrong
            # hole would cap a 208 m drive at a par 3's length – so with other tees close by
            # the hole is left open, with the candidates for the caller to pick from.
            near = [c for c in cands if _metres((lat, lon), (c[3]["line"][0][0], c[3]["line"][0][1])) <= TEE_CLUSTER_M]
            if len(near) > 1:
                out["alternatives"] = [_hole_info(c) for c in sorted(near, key=lambda c: c[0])]
                return out
        out.update(_hole_info(best))
        # How much closer this hole is than any other: a small margin means "could be the
        # parallel hole" (used before trusting this clip to resolve its neighbours).
        others = [c[0] for c in cands if c[3] is not best[3]]
        out["margin"] = round(min(others) - best[0], 1) if others else 999.0
    return out


def _hole_info(c: tuple[float, float, float, dict[str, Any]]) -> dict[str, Any]:
    d, s, length, h = c
    return {"hole": str(h["ref"])[:8], "par": int(h["par"]) if str(h.get("par", "")).isdigit() else None,
            "fromTee": round(s, 1), "toGreen": round(max(0.0, length - s), 1), "line": h["line"][:50]}


def green_distance(lat: float, lon: float, course: dict[str, Any] | None = None) -> float | None:
    """Metres from a point to the nearest mapped green (0 = on it); None when no green is mapped."""
    data = course if course is not None else cached_course(lat, lon)
    best: float | None = None
    for f in data.get("features", []):
        if f.get("k") != "green" or len(f.get("ring", [])) < 3:
            continue
        pts = [_local((lat, lon), q) for q in f["ring"]]
        inside, d = False, 1e12
        for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1]):
            if (ay > 0) != (by > 0) and ax + (0 - ay) * (bx - ax) / (by - ay) > 0:
                inside = not inside
            dx, dy = bx - ax, by - ay
            t = max(0.0, min(1.0, (-ax * dx - ay * dy) / ((dx * dx + dy * dy) or 1e-9)))
            d = min(d, math.hypot(ax + t * dx, ay + t * dy))
        d = 0.0 if inside else d
        best = d if best is None else min(best, d)
    return None if best is None else round(best, 1)


def pick_alternative(place: dict[str, Any], previous_hole: str | None, next_hole: str | None) -> dict[str, Any]:
    """Resolves an ambiguous tee with the holes filmed just before/after (a round goes 1, 2, 3 …):
    the candidate that follows the previous hole, or precedes the next one. Else unchanged."""
    alts = place.get("alternatives") or []
    num = lambda h: int(h) if str(h).isdigit() else None  # noqa: E731
    prev, nxt = num(previous_hole), num(next_hole)
    best = None
    for a in alts:
        n = num(a["hole"])
        if n is None:
            continue
        score = min((abs(n - (prev + 1)) if prev is not None else 99), (abs(n - nxt) if nxt is not None else 99))
        if score <= 1 and (best is None or score < best[0]):
            best = (score, a)
    if best is None:
        return place
    return {**{k: v for k, v in place.items() if k != "alternatives"}, **best[1]}


@router.get("/geo/place")
def place(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180), _: User = Depends(current_user)):
    return place_at(lat, lon)


@router.get("/geo/search")
def search(q: str = Query(min_length=2, max_length=120), _: User = Depends(current_user)):
    def fetch():
        with _client() as c:
            try:
                r = c.get(NOMINATIM, params={"q": q, "format": "jsonv2", "limit": 6})
                r.raise_for_status()
            except httpx.HTTPError as exc:
                raise ApiError(502, "osm_unavailable", "Search is not working right now.", {"error": repr(exc)[:200]}) from exc
            return [{"name": x.get("display_name", "")[:160], "lat": float(x["lat"]), "lon": float(x["lon"])} for x in r.json()]

    return _cached("search", q.strip().lower(), fetch)
