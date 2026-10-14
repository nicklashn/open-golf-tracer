from shottracer.detect import Box, feet_roi


def test_feet_roi_reaches_a_face_on_ball_mid_swing():
    """Real face-on clip: golfer box 268 x 626 px mid-backswing, ball 0.75 box widths to the right."""
    golfer = Box(20, 675, 288, 1301)
    roi = feet_roi(golfer, 1080, 1920)
    assert roi.x1 <= 492 <= roi.x2 and roi.y1 <= 1245 <= roi.y2
    # ...but not out to the cup 330 px further away.
    assert roi.x2 < 621


def test_far_away_players_are_not_the_golfer():
    from shottracer.detect import pick_golfer

    far = Box(735, 786, 749, 853)  # someone down the fairway in a 1080x1920 clip
    assert pick_golfer([far], 1080, 1920) is None
    golfer = Box(300, 900, 600, 1700)
    assert pick_golfer([far, golfer], 1080, 1920) is golfer
