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


def test_onnx_postprocessing_matches_rfdetr():
    """Sigmoid scores, COCO ids from the flat top-k index, cxcywh boxes scaled to the image
    (as rfdetr's PostProcess), without running a real model."""
    import threading

    import numpy as np

    from shottracer.detect import OnnxRfDetrBallDetector

    logits = np.full((1, 300, 91), -10.0, np.float32)
    boxes = np.zeros((1, 300, 4), np.float32)
    logits[0, 5, 37] = 0.0  # sports ball, sigmoid 0.5
    boxes[0, 5] = (0.5, 0.75, 0.01, 0.02)
    logits[0, 9, 1] = 2.0  # person, sigmoid 0.88
    boxes[0, 9] = (0.25, 0.5, 0.2, 1.4)  # taller than the image: clamped

    class Session:
        def run(self, _outputs, feeds):
            assert feeds["input"].shape == (1, 3, 704, 704)
            return [boxes, logits]

    det = OnnxRfDetrBallDetector.__new__(OnnxRfDetrBallDetector)
    det.session, det.input, det._run_lock = Session(), "input", threading.Lock()
    det.names = {1: "person", 37: "sports ball"}
    out = det._predict(np.zeros((1000, 2000, 3), np.uint8), 0.05)
    assert [k for k, _ in out] == ["person", "sports ball"]
    person, ball = out[0][1], out[1][1]
    assert abs(person.conf - 0.8808) < 1e-3
    assert np.allclose((person.x1, person.y1, person.x2, person.y2), (300, 0, 700, 1000))
    assert abs(ball.conf - 0.5) < 1e-6
    assert np.allclose((ball.x1, ball.y1, ball.x2, ball.y2), (990, 740, 1010, 760))
