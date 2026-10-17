"""The OpenStreetMap cache: what is (not) cached, broken files, back-off and one fetch per area."""
import json
import os
import threading
import time

import pytest

GOOD = {"elements": [{"type": "way", "tags": {"golf": "green"}, "geometry": [{"lat": 56.0, "lon": 11.0}, {"lat": 56.0001, "lon": 11.0},
                                                                          {"lat": 56.0001, "lon": 11.0001}]}]}


class FakeOverpass:
    def __init__(self, body, delay=0.0):
        self.body, self.delay, self.calls = body, delay, 0
        self.lock = threading.Lock()

    def __call__(self):
        fake = self

        class Resp:
            def raise_for_status(self):
                pass

            def json(self):
                return fake.body

        class Client:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def post(self, url, data):
                with fake.lock:
                    fake.calls += 1
                time.sleep(fake.delay)
                return Resp()

        return Client()


@pytest.fixture()
def geo(env, monkeypatch):
    from golf_api.routes import geo

    return geo


def _fake(monkeypatch, geo, body, delay=0.0):
    f = FakeOverpass(body, delay)
    monkeypatch.setattr(geo, "_client", f)
    return f


def test_a_timed_out_answer_is_not_a_course_and_backs_off(geo, monkeypatch):
    from golf_api.errors import ApiError

    monkeypatch.setattr(geo.time, "sleep", lambda s: None)   # the pause between rounds of servers
    f = _fake(monkeypatch, geo, {"remark": "runtime error: Query timed out in \"query\" at line 3 after 30 seconds.", "elements": []})
    with pytest.raises(ApiError) as e:
        geo.cached_course(56.0, 11.0)
    assert e.value.code == "osm_unavailable"
    assert not list((geo._folder()).glob("course_*.json"))      # nothing cached
    calls = f.calls
    with pytest.raises(ApiError):
        geo.cached_course(56.0, 11.0)                           # backing off: no new request
    assert f.calls == calls


def test_empty_results_are_cached_only_briefly_and_broken_files_are_misses(geo, monkeypatch):
    f = _fake(monkeypatch, geo, {"elements": []})
    assert geo.cached_course(56.0, 11.0)["features"] == []
    assert geo.cached_course(56.0, 11.0)["features"] == []
    assert f.calls == 1
    idx_file = geo._folder() / "course_index.json"
    idx = json.loads(idx_file.read_text())
    idx[0]["t"] -= geo.EMPTY_CACHE_S + 1
    idx_file.write_text(json.dumps(idx))
    f.body = GOOD
    assert geo.cached_course(56.0, 11.0)["features"]           # asked again
    assert f.calls == 2
    for c in geo._folder().glob("course_*.json"):
        c.write_text('{"features": [', encoding="utf-8")       # half written by an older version
    assert geo.cached_course(56.0, 11.0)["features"]
    assert f.calls == 3
    idx_file.write_text("garbage")
    assert geo.cached_course(56.0, 11.0)["features"]


def test_one_fetch_per_area_at_a_time(geo, monkeypatch):
    f = _fake(monkeypatch, geo, GOOD, delay=0.3)
    out = []
    ts = [threading.Thread(target=lambda: out.append(geo.cached_course(56.0, 11.0))) for _ in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert len(out) == 4 and f.calls == 1


def test_prune_removes_expired_files(geo, monkeypatch):
    _fake(monkeypatch, geo, GOOD)
    geo.cached_course(56.0, 11.0)
    folder = geo._folder()
    old = time.time() - (geo.CACHE_DAYS + 1) * 86400
    (folder / "search_abc.json").write_text("[]")
    os.utime(folder / "search_abc.json", (old, old))
    (folder / "x.json.1.2.tmp").write_text("{")
    os.utime(folder / "x.json.1.2.tmp", (old, old))
    idx = json.loads((folder / "course_index.json").read_text())
    idx[0]["t"] = old
    (folder / "course_index.json").write_text(json.dumps(idx))
    for c in folder.glob("course_*.json"):
        if c.name != "course_index.json":
            os.utime(c, (old, old))
    assert geo.prune_cache(force=True) == 3
    assert [p.name for p in folder.iterdir()] == ["course_index.json"]
