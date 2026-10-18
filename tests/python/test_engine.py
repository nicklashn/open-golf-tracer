"""Regression tests on synthetic videos with known ground truth (slow; needs YOLO weights)."""
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "out"
WEIGHTS = ROOT / "models" / "yolo26x.pt"
HAS_YOLO = WEIGHTS.exists() and importlib.util.find_spec("ultralytics") is not None  # requirements-yolo.txt
RFDETR_ONNX = ROOT / "models" / "rf-detr-large.onnx"  # scripts/fetch_model.py

pytestmark = pytest.mark.skipif(not (RFDETR_ONNX.exists() or WEIGHTS.exists() or os.environ.get("GOLF_DETECTOR")),
                                reason="detector weights not downloaded")


@pytest.fixture(autouse=True, scope="module")
def _yolo_for_drawn_videos():
    """These clips test the pipeline logic, not the detector. Their ball is a flat drawn dot,
    which RF-DETR sees at the right spot but with ~0.1 confidence (real balls: 0.4-0.7), below
    the address thresholds, so they run on YOLO when its weights are present. RF-DETR is covered
    by the e2e upload."""
    from shottracer.detect import get_detector

    old = os.environ.get("GOLF_DETECTOR")
    if HAS_YOLO and old is None:
        os.environ["GOLF_DETECTOR"] = "yolo"
    get_detector.cache_clear()
    yield
    if old is None:
        os.environ.pop("GOLF_DETECTOR", None)
    get_detector.cache_clear()


def _video(name: str, *args: str) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.mp4"
    if not path.exists():
        subprocess.run([sys.executable, str(ROOT / "tests" / "make_synthetic.py"), str(path), *args], check=True,
                       capture_output=True)
    return path


def _truth(path: Path) -> dict:
    return json.loads(path.with_suffix(".truth.json").read_text())


# In these two clips RF-DETR misses the faint drawn ball (shots go missing, no carry), so they
# only run with the optional YOLO detector; the weekly CI job has no YOLO weights.
needs_yolo = pytest.mark.skipif(not HAS_YOLO, reason="needs YOLO (requirements-yolo.txt and models/yolo26x.pt): "
                                                     "RF-DETR misses the drawn ball in this clip")


@pytest.mark.slow
@pytest.mark.parametrize("name,args", [("syn", []), pytest.param("multi", ["--shots", "3"], marks=needs_yolo),
                                       ("noaudio", ["--no-audio", "--phi", "-6"]),
                                       pytest.param("portrait", ["--portrait", "--fps", "60"], marks=needs_yolo)])
def test_analyze_finds_every_shot(name, args):
    from shottracer.pipeline import analyze

    path = _video(name, *args)
    truth = _truth(path)
    res = analyze(path)
    assert len(res["shots"]) == len(truth["impacts"])
    for shot, t_imp in zip(res["shots"], truth["impacts"]):
        assert abs(shot["impactTime"] - t_imp) < 0.05
        assert shot["kind"] == "full"
        assert abs(shot["stats"]["carry_m"] - truth["stats"]["carry_m"]) < 0.15 * truth["stats"]["carry_m"]
        assert abs(shot["anchor"]["x"] - truth["anchor"][0]) < 4
        assert abs(shot["anchor"]["y"] - truth["anchor"][1]) < 4


@pytest.mark.slow
@pytest.mark.parametrize("name,args", [("fps24", ["--fps", "24"]), ("fps120", ["--fps", "120"])])
def test_frame_rates(name, args):
    from shottracer.pipeline import analyze

    path = _video(name, *args)
    truth = _truth(path)
    shot = analyze(path)["shots"][0]
    assert abs(shot["impactTime"] - truth["impacts"][0]) < 1.5 / truth["fps"] + 0.02
    assert abs(shot["stats"]["carry_m"] - truth["stats"]["carry_m"]) < 0.15 * truth["stats"]["carry_m"]


@pytest.mark.slow
def test_hdr_hlg_gives_same_result_as_sdr():
    """iPhone-style HEVC 10-bit HLG: same result as the SDR original."""
    from shottracer.pipeline import analyze
    from shottracer.video import ffmpeg_bin

    sdr = _video("syn")
    hdr = OUT / "hdr.mp4"
    if not hdr.exists():
        subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-i", str(sdr), "-vf",
                        "zscale=tin=bt709:min=bt709:pin=bt709:t=arib-std-b67:m=bt2020nc:p=bt2020,format=yuv420p10le",
                        "-c:v", "libx265", "-crf", "16", "-x265-params",
                        "log-level=error:keyint=30:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc",
                        "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc",
                        "-tag:v", "hvc1", "-c:a", "copy", str(hdr)], check=True)
    truth = _truth(sdr)
    res = analyze(hdr)
    assert res["media"]["hdr"]
    shot = res["shots"][0]
    assert abs(shot["impactTime"] - truth["impacts"][0]) < 0.05
    assert abs(shot["anchor"]["x"] - truth["anchor"][0]) < 4
    assert abs(shot["anchor"]["y"] - truth["anchor"][1]) < 4
    assert abs(shot["stats"]["carry_m"] - truth["stats"]["carry_m"]) < 0.15 * truth["stats"]["carry_m"]


@pytest.mark.slow
def test_chip_does_not_become_a_long_drive():
    """Short shots must give a short (or flagged) flight, never a confident 200 m bane."""
    from shottracer.pipeline import analyze

    path = _video("chip", "--speed", "18", "--theta", "35")
    truth = _truth(path)
    shot = analyze(path)["shots"][0]
    codes = {w["code"] for w in shot["warnings"]}
    assert shot["kind"] == "short" or codes & {"short_shot", "implausible", "no_track"} or \
        shot["stats"]["carry_m"] < 2 * truth["stats"]["carry_m"]
