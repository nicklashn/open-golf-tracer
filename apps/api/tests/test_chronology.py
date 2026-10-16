"""When a clip was filmed and the order of a round. The ordering cases mirror
packages/compose/test/chronology.test.ts: both sides must order a round alike."""
import datetime as dt

from testkit import upload

from golf_api.chronology import by_hole, clip_slot, epoch, file_time, filename_time, gopro, metadata_time, name_key, round_order, settle
from golf_api.documents import attach_video, merged_document

NOW = dt.datetime(2026, 10, 16, 12, tzinfo=dt.UTC)


def local(*parts: int) -> str:
    return dt.datetime(*parts).astimezone().isoformat()  # type: ignore[misc]


def test_metadata_prefers_apple_and_treats_creation_time_as_utc():
    tags = {"com.apple.quicktime.creationdate": "2026-10-16T10:15:23+0200", "creation_time": "2026-10-16T08:15:24.000000Z"}
    assert metadata_time(tags, NOW) == "2026-10-16T10:15:23+02:00"
    assert metadata_time({"creation_time": "2026-10-16T08:15:24.000000Z"}, NOW) == "2026-10-16T08:15:24+00:00"
    assert metadata_time({"creation_time": "2026-10-16 08:15:24"}, NOW) == "2026-10-16T08:15:24+00:00"
    # A bogus Apple date falls back to creation_time.
    assert metadata_time({"com.apple.quicktime.creationdate": "1904-01-01T00:00:00Z", "creation_time": "2026-10-16T08:15:24Z"}, NOW) \
        == "2026-10-16T08:15:24+00:00"


def test_metadata_ignores_bogus_dates():
    for bad in ("1970-01-01T00:00:00.000000Z", "1904-01-01T00:00:00Z", "2004-12-31T23:59:59Z", "2027-01-01T00:00:00Z", "garbage", ""):
        assert metadata_time({"creation_time": bad}, NOW) is None, bad


def test_times_in_file_names():
    assert filename_time("PXL_20261016_101523123.mp4", NOW) == "2026-10-16T10:15:23.123+00:00"
    assert filename_time("PXL_20261016_101523123.TS.mp4", NOW) == "2026-10-16T10:15:23.123+00:00"
    assert filename_time("VID_20261016_101523.mp4", NOW) == local(2026, 10, 16, 10, 15, 23)
    assert filename_time("IMG_20261016_101523_1.mp4", NOW) == local(2026, 10, 16, 10, 15, 23)
    assert filename_time("20261016_101523.mp4", NOW) == local(2026, 10, 16, 10, 15, 23)
    assert filename_time("2026-10-16 10.15.23.mov", NOW) == local(2026, 10, 16, 10, 15, 23)
    for none in ("VID-20261016-WA0003.mp4", "GX010123.MP4", "GOPR0123.MP4", "clip.mp4", "20261316_101523.mp4",
                 "VID_20271016_101523.mp4", "IMG_0123.MOV", "202610161_01523.mp4"):
        assert filename_time(none, NOW) is None, none


def test_file_time_is_the_last_fallback():
    ms = dt.datetime(2026, 10, 16, 9, 0, 1, tzinfo=dt.UTC).timestamp() * 1000
    assert file_time(ms, NOW) == "2026-10-16T09:00:01+00:00"
    assert file_time(0, NOW) is None and file_time(None, NOW) is None and file_time(1e18, NOW) is None
    assert settle({"recordedAt": "2026-10-16T09:00:00+00:00"}, "VID_20261016_101523.mp4", ms)["recordedAtSource"] == "metadata"
    assert settle({}, "VID_20261016_101523.mp4", ms)["recordedAtSource"] == "filename"
    assert settle({}, "clip.mp4", ms)["recordedAtSource"] == "file"
    assert settle({}, "clip.mp4", None) == {}


def test_names_sort_naturally_and_gopro_chapters_stay_together():
    assert gopro("GX010123.MP4") == (123, 1) and gopro("GH020123.MP4") == (123, 2)
    assert gopro("GOPR0123.MP4") == (123, 0) and gopro("GP010123.MP4") == (123, 1)
    assert gopro("GX0101234.MP4") is None and gopro("IMG_0123.MOV") is None

    def by_name(names):
        return sorted(names, key=name_key)
    assert by_name(["clip10.mp4", "clip9.mp4", "Clip1.mp4"]) == ["Clip1.mp4", "clip9.mp4", "clip10.mp4"]
    assert by_name(["GX010124.MP4", "GX020123.MP4", "GX010123.MP4"]) == ["GX010123.MP4", "GX020123.MP4", "GX010124.MP4"]
    assert by_name(["GP010123.MP4", "GOPR0123.MP4"]) == ["GOPR0123.MP4", "GP010123.MP4"]
    assert by_name(["VID-20261016-WA0010.mp4", "VID-20261016-WA0003.mp4", "VID-20261015-WA0042.mp4"]) == \
        ["VID-20261015-WA0042.mp4", "VID-20261016-WA0003.mp4", "VID-20261016-WA0010.mp4"]


def media(name, recorded_at=None, hole=None, source=None):
    return {"id": name, "kind": "video", "name": name, "duration": 10, "recordedAt": recorded_at, "recordedAtSource": source,
            "place": {"course": "Testbane", "hole": hole} if hole else None}


def names(ms):
    return [m["name"] for m in ms]


def test_round_order_by_sure_times_across_time_zones():
    order = round_order([media("b.mov", "2026-10-16T12:30:00+0200"), media("a.mp4", "2026-10-16T10:00:00Z", source="filename"),
                         media("GX020123.MP4", "2026-10-16T10:40:00Z"), media("c.mov", "2026-10-16T10:20:00Z"),
                         media("GX010123.MP4", "2026-10-16T10:10:00Z")])
    assert names(order) == ["a.mp4", "GX010123.MP4", "GX020123.MP4", "c.mov", "b.mov"]


def test_round_order_falls_back_to_holes_and_wraps():
    f = "file"
    order = round_order([media("x.mp4", "2026-10-16T08:00:00Z", source=f), media("h3.mp4", "2026-10-16T08:00:01Z", "3", f),
                         media("h1.mp4", "2026-10-16T08:00:02Z", "1", f)])
    assert names(order) == ["h1.mp4", "h3.mp4", "x.mp4"]
    assert names(round_order([media("b.mp4"), media("z.mov", "2026-10-16T10:00:00Z"), media("a.mp4")])) == ["z.mov", "a.mp4", "b.mp4"]

    def holes(hs):
        return names(by_hole([media(f"h{h}", hole=h) for h in hs]))
    assert holes(["3", "18", "10", "1", "12"]) == ["h10", "h12", "h18", "h1", "h3"]
    assert holes(["9", "1", "5"]) == ["h1", "h5", "h9"]
    assert holes([str(18 - i) for i in range(18)])[0] == "h1"


def test_attach_goes_before_the_first_later_clip():
    doc = {"media": {"a": media("a", "2026-10-16T10:00:00Z"), "c": media("c", "2026-10-16T10:20:00Z")},
           "clips": [{"id": "ca", "mediaId": "a"}, {"id": "cc", "mediaId": "c"}]}
    attach_video(doc, media("b", "2026-10-16T10:10:00+00:00"))
    attach_video(doc, media("n"))
    attach_video(doc, media("e", "2026-10-16T12:30:00+0200"))
    assert [c["mediaId"] for c in doc["clips"]] == ["a", "b", "c", "e", "n"]
    assert clip_slot(doc, "missing") == len(doc["clips"])
    assert epoch("2026-10-16T12:10:00+0200") == epoch("2026-10-16T10:10:00Z")


def test_upload_keeps_the_time_source(client, tiny_video):
    ms = dt.datetime(2026, 10, 16, 9, 0, 1, tzinfo=dt.UTC).timestamp() * 1000
    res = upload(client, tiny_video, filename="VID_20261016_101523.mp4", last_modified=ms)
    assert res["media"]["recordedAt"] == local(2026, 10, 16, 10, 15, 23)
    assert res["media"]["recordedAtSource"] == "filename"
    doc = client.get(f"/api/projects/{res['projectId']}").json()["document"]
    assert doc["media"][res["media"]["id"]]["recordedAtSource"] == "filename"
    res = upload(client, tiny_video, filename="golf.mp4", last_modified=ms)
    assert (res["media"]["recordedAt"], res["media"]["recordedAtSource"]) == ("2026-10-16T09:00:01+00:00", "file")


def test_clips_of_a_round_without_times_join_by_hole(client, tiny_video):
    """The server places a joining clip once its hole is known (merged on load, like the editor)."""
    from golf_api.db import session_scope
    from golf_api.models import Project

    p = client.post("/api/projects", json={"name": "Runde"}).json()
    ids = [upload(client, tiny_video, project_id=p["id"], filename=f"golf{i}.mp4")["media"]["id"] for i in range(3)]
    with session_scope() as db:
        proj = db.get(Project, p["id"])
        assert proj is not None
        a = dict(proj.analysis or {})
        for mid, hole in zip(ids, ["12", "2", "11"], strict=True):
            a[mid] = {**a[mid], "place": {"course": "Testbane", "hole": hole, "par": 4, "fromTee": 0, "toGreen": 300, "line": []}}
        proj.analysis = a
    doc = merged_document_of(p["id"])
    assert [doc["media"][c["mediaId"]]["place"]["hole"] for c in doc["clips"]] == ["11", "12", "2"]


def merged_document_of(project_id):
    from golf_api.db import session_scope
    from golf_api.models import Project

    with session_scope() as db:
        proj = db.get(Project, project_id)
        assert proj is not None
        return merged_document(proj)


def test_probe_reads_the_recording_time(tmp_path):
    import subprocess

    from golf_api.probe import probe_file

    def clip(name, *meta):
        p = tmp_path / name
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10:duration=1", *meta,
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(p)], check=True)
        return probe_file(p)
    info = clip("a.mp4", "-metadata", "creation_time=2026-10-16T08:15:24.000000Z")
    assert (info["recordedAt"], info["recordedAtSource"]) == ("2026-10-16T08:15:24+00:00", "metadata")
    info = clip("b.mov", "-metadata", "com.apple.quicktime.creationdate=2026-10-16T10:15:23+0200",
                "-metadata", "creation_time=2026-10-16T09:00:00Z", "-movflags", "use_metadata_tags")
    assert info["recordedAt"] == "2026-10-16T10:15:23+02:00"
    assert "recordedAt" not in clip("c.mp4", "-metadata", "creation_time=1970-01-01T00:00:00Z")
