"""Hole matching from a video's GPS (no network: a hand-made course)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))

from golf_api.routes.geo import place_at  # noqa: E402

COURSE = {
    "course": "Testbane",
    "features": [],
    "holes": [
        {"ref": "6", "par": "4", "name": "", "line": [[56.2000, 11.7000], [56.2030, 11.7000]]},   # ~334 m north
        {"ref": "7", "par": "3", "name": "", "line": [[56.2000, 11.7100], [56.2013, 11.7100]]},   # ~620 m east
    ],
}


def test_fairway_shot_is_matched_to_the_hole_line():
    p = place_at(56.2016, 11.7001, course=COURSE)   # on the fairway of hole 6, ~6 m off the line
    assert p["hole"] == "6" and p["par"] == 4
    assert abs(p["fromTee"] - 178) < 3 and abs(p["toGreen"] - 156) < 3


def test_tee_shot_and_far_away():
    assert place_at(56.2000, 11.7100, course=COURSE)["hole"] == "7"
    far = place_at(56.2100, 11.7300, course=COURSE)
    assert far["hole"] == "" and far["course"] == "Testbane"


def test_a_tee_next_to_the_previous_green_wins():
    """Filmed between hole 6's green and hole 8's tee (a little further): it is a tee shot."""
    course = {"course": "X", "features": [], "holes": [
        {"ref": "6", "par": "4", "name": "", "line": [[56.2000, 11.7000], [56.2030, 11.7000]]},
        {"ref": "8", "par": "4", "name": "", "line": [[56.2032, 11.7004], [56.2060, 11.7004]]},
    ]}
    p = place_at(56.20305, 11.70015, course=course)   # ~10 m past 6's end, ~20 m from 8's tee
    assert p["hole"] == "8" and p["fromTee"] < 15
    # Well short of the green it stays hole 6.
    assert place_at(56.2025, 11.7001, course=course)["hole"] == "6"


def test_shared_tees_are_left_open_and_resolved_by_the_round():
    """Two holes start from tees 20 m apart: the hole is a guess, so none is claimed (a par 3's
    length must not cap a drive); the clips around it in the round decide."""
    from golf_api.routes.geo import pick_alternative

    course = {"course": "X", "features": [], "holes": [
        {"ref": "7", "par": "3", "name": "", "line": [[56.2000, 11.7000], [56.2013, 11.7000]]},
        {"ref": "17", "par": "5", "name": "", "line": [[56.2000, 11.7003], [56.2040, 11.7003]]},
    ]}
    p = place_at(56.19995, 11.70015, course=course)
    assert p["hole"] == "" and p["toGreen"] is None
    assert sorted(a["hole"] for a in p["alternatives"]) == ["17", "7"]
    assert pick_alternative(p, previous_hole="16", next_hole=None)["hole"] == "17"
    assert pick_alternative(p, previous_hole=None, next_hole="17")["par"] == 5
    assert pick_alternative(p, previous_hole="2", next_hole=None).get("alternatives")   # nothing fits
