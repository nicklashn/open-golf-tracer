# Licences

Short version: **Open Golf Tracer is open source under the MIT licence ([LICENSE](../LICENSE)).**
Anyone may use, modify, share and sell the code, also in closed products, as long as the copyright
and licence text come along. All dependencies in the default install have permissive licences that
are compatible with that. Reviewed 2026-10-14 (every Python and npm package, see section 5).

The Windows installer carries **`THIRD_PARTY_NOTICES.txt`** (Settings → About → *Third-party
licences*): the licences of Node.js, Python, FFmpeg, ONNX Runtime, the RF-DETR model and the fonts,
plus every bundled Python and npm package with its licence. `installer/build.ps1` generates it with
`scripts/third_party_notices.py` from what is actually in the installer.

## 0. The project's licence

- `LICENSE` holds the MIT text, and every `package.json` has `"license": "MIT"`.
- Contributions are accepted under the same licence (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
- GPL/AGPL packages must not be part of the default install. That is why the optional YOLO detector
  (`ultralytics`, AGPL-3.0) lives in a separate `requirements-yolo.txt`.
- There are no secrets, model weights or private videos in the repository. The demo videos are
  drawn by `scripts/make_demo.py`.

## 1. The ball detector (RF-DETR, Apache 2.0)

`shottracer/detect.py` uses **RF-DETR Large** from Roboflow (the `rfdetr` package) by default,
pretrained on COCO. Code and weights for the sizes Nano, Small, Medium and Large are Apache 2.0 and
may be used commercially. (Atto, Femto, Pico, XL and 2XL are part of `rfdetr_plus` under PML 1.0 and
are not used.) The app runs it as ONNX (`scripts/export_onnx.py`, weights unchanged), published as
the `models-v1` release in this repository and downloaded to `models/rf-detr-large.onnx` at setup or
at the first analysis; the Windows installer includes it. Apache 2.0 allows redistributing the
weights together with the licence text: **`models/LICENSE-rf-detr`** ships next to the model (the
upstream project has no NOTICE file). RF-DETR's DINOv2 backbone is Apache 2.0 as well.

On the reference clips (2026-10-14) RF-DETR gave exactly the same shots and numbers as YOLO. D-FINE
and RT-DETRv2 (also Apache 2.0) were tested and rejected: they reported false shots when the golfer
picked up the tee.

| Detector | Selected with | Licence | Quality |
|---|---|---|---|
| `RfDetrBallDetector` | default (`GOLF_DETECTOR=rfdetr`) | Apache 2.0 | Same as YOLO on our clips; also finds the golfer |
| `YoloBallDetector` | `GOLF_DETECTOR=yolo` or `--model yolo26x.pt` | AGPL-3.0 / Enterprise | Reference; about $5,000/year for Enterprise (quote only) |
| `BlobBallDetector` | `GOLF_DETECTOR=blob` | nothing extra (OpenCV, Apache 2.0) | Classic image processing; good on quiet courses, weaker in busy scenes |

The interface is `BallDetector` (the methods `ball(frame, golfer)` and `people(frame)`); another
model is plugged in with `GOLF_DETECTOR=<module>:<class>`. The in-flight tracking itself
(`track.py`), the physics and the tracer use none of the models.

`ultralytics` is **not** part of the default install. To compare with YOLO (or run the synthetic
tests on YOLO), install it with `pip install -r requirements-yolo.txt`. It is AGPL-3.0, so it does
not belong in an install that is passed on under MIT terms.

## 2. FFmpeg

FFmpeg itself is LGPL-2.1+, but the common builds (Gyan, BtbN, Homebrew, apt) are built with
`--enable-gpl` and contain x264/x265 (GPL). The app **runs `ffmpeg`/`ffprobe` as separate
programs** and does not link to them, so the app's own code does not become GPL. Whoever
distributes the FFmpeg binary together with the app must follow the GPL terms for that binary
(source code offer, licence text). The repository contains no FFmpeg binary; you install it yourself.

The **Windows installer** (`installer/`) ships gyan.dev's "release essentials" build (GPL-3.0,
built with `--enable-gpl --enable-version3`) in `runtime\ffmpeg` together with its `LICENSE` and
`README.txt`, which point to the source code and the build recipe. `THIRD_PARTY_NOTICES.txt` names
the exact FFmpeg version, its configuration and the link to the matching source release
(`https://ffmpeg.org/releases/ffmpeg-<version>.tar.xz`). It is a separate binary next to the app
(aggregation), so the MIT code is not affected. Node.js (MIT), Python (PSF, python-build-standalone),
ONNX Runtime (MIT) and the RF-DETR model (Apache 2.0) come along as well. `onnxruntime-directml`
contains Microsoft's `DirectML.dll`, which Microsoft itself distributes in the wheel for use in
apps; it is passed on unchanged.

H.264/HEVC are also patent-encumbered formats (MPEG LA/Access Advance). The hardware encoders
(NVENC, Quick Sync, VideoToolbox) are licensed through the hardware/OS.

## 3. Fonts (SIL Open Font License 1.1)

Inter, Oswald, Bebas Neue, Barlow Condensed and Playfair Display are included as static,
Latin-subset versions in `assets/fonts/static` (made with fonttools from the official variable
fonts). The OFL allows embedding them in apps and burning text set in them into videos. Subset
versions are "Modified Versions" and must not carry a Reserved Font Name. Playfair Display has the
Reserved Font Name "Playfair Display", so our subset is called **GT Serif Display** internally and
shown as "Serif Display" in the app. The other four have no reserved names. The licence texts sit
next to the files (`assets/fonts/*-OFL.txt` and in `static/`).

## 4. Maps (Measure on map / course map)

- **Course data** (fairways, greens, bunkers, holes) is fetched from OpenStreetMap via Overpass and
  search via Nominatim, through the API (`/api/geo/*`) with a cache in `data/cache/osm`. The data is
  **ODbL**: the graphics must credit "© OpenStreetMap" (the course map does so itself). Both services
  are free and meant for light use, which fits one person on their own PC.
- **Map tiles in the editor:** OpenStreetMap's own tiles (`tile.openstreetmap.org`) may be used
  interactively with credit, but not for heavy traffic. **Satellite imagery** comes from Esri World
  Imagery, whose terms require an ArcGIS account/licence for commercial use. Locally for personal
  use both are fine, so the satellite button is shown by default only on localhost and the home
  network (`NEXT_PUBLIC_MAP_SATELLITE`).
- *Note:* if you make the app available to many others, you must arrange licensed map access
  yourself (your own Overpass, and tiles from e.g. MapTiler, Stadia or Esri with an account).
- The video's GPS position is read from the file's metadata and is only sent to the map/OSM when
  you open "Measure on map" yourself.

## 5. Other dependencies

| Package | Licence |
|---|---|
| Next.js, React, Radix UI, Tailwind CSS, zustand, immer, zod, clsx, tailwind-merge, class-variance-authority | MIT |
| lucide-react | ISC |
| Leaflet (map in the editor) | BSD-2-Clause |
| opentype.js, @napi-rs/canvas, esbuild, tsx | MIT |
| FastAPI, Starlette, Pydantic, SQLAlchemy, Alembic, uvicorn, httpx, jsonschema | MIT / BSD |
| NumPy, SciPy, numba | BSD |
| ONNX Runtime (onnxruntime / onnxruntime-directml) | MIT |
| PyTorch (only the optional `requirements-torch.txt`) | BSD |
| OpenCV (opencv-python-headless) | Apache 2.0 |
| Playwright | Apache 2.0 (tests only) |
| axe-core, lightningcss | MPL-2.0 (test/build only, not part of the product) |
| sharp (images in Next.js) | Apache 2.0; the bundled libvips is LGPL-3.0, loaded as a separate library |
| PyAV | BSD-3-Clause; the wheels contain FFmpeg libraries under the LGPL |
| certifi, tqdm | MPL-2.0 (unmodified use is unproblematic) |
| caniuse-lite (via Next.js/browserslist) | CC-BY-4.0 (data) |
| @fontsource-variable/inter | SIL OFL 1.1 |

Full review 2026-10-14: no GPL, AGPL or "non-commercial" licences in the default install (only
`ultralytics` in the optional `requirements-yolo.txt`). RF-DETR's dependencies (transformers,
huggingface_hub, supervision, safetensors) are Apache 2.0/MIT. Check again when adding packages:
`npx license-checker --production --summary` and `pip-licenses`, or generate the full list with
`python scripts/third_party_notices.py` (writes `THIRD_PARTY_NOTICES.txt` for this checkout). A pull
request that adds a dependency updates this file (see the pull request template).

## 6. Our own content

The Birdie mascot, the logo, the icons, the demo video (drawn by `scripts/make_demo.py`) and the
texts were made for this project and are released under the MIT licence like the code. There are
no stock images or videos in the repository.
