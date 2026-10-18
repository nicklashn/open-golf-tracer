# Open Golf Tracer

A web editor for golf videos with an automatic, broadcast-style shot tracer. Upload a video and
the app finds every shot, draws the ball flight in 3D and lets you adjust it with handles that
refit the physics live. Add text, stat cards and templates, cut on the timeline, make slow-mo and
one short per shot, and export to Shorts, Reels, TikTok and YouTube – with HDR and audio kept.

Everything runs locally on your own machine. Your videos never leave it. Free and open source (MIT).

![Before/after](docs/hero.jpg)

## Install on Windows (easiest)

1. Download **`OpenGolfTracer-Setup-<version>.exe`** from
   [Releases](https://github.com/nicklashn/open-golf-tracer/releases).
2. Double-click it. Windows may say *"Windows protected your PC"* because the installer is not
   signed – click **More info → Run anyway**. No admin rights are needed.
3. Start **Open Golf Tracer** from the Start menu or the desktop. The browser opens by itself;
   close the black window to stop the app.

Nothing else has to be installed and nothing is downloaded: Node.js, Python, FFmpeg and the ball
detector come with it. Your projects and
videos are kept in `%LOCALAPPDATA%\Programs\Open Golf Tracer\data`, also when you update.
Uninstall it under *Settings → Apps*; you are asked whether your projects should be deleted too.

**Make video for me** works out of the box without AI. To let an AI model help (optional), open
**Settings → AI** in the app, pick Ollama (runs on your own PC), an OpenAI-compatible service or
Anthropic, paste a key if the service needs one, and click **Test connection** – or pick
**ChatGPT (your plan)** and **Continue with ChatGPT** to use your ChatGPT Plus/Pro plan without a key.

To build the installer yourself: `powershell -ExecutionPolicy Bypass -File installer\build.ps1`
(needs Git and [Inno Setup 6](https://jrsoftware.org/isinfo.php): `winget install JRSoftware.InnoSetup`).
Everything it bundles is pinned to an exact version and SHA-256 in `installer/versions.psd1`, and the
Python packages come from `requirements-lock.txt` (with hashes). Releases are made by GitHub Actions,
see [CONTRIBUTING.md](CONTRIBUTING.md#releasing).
The installer owns the program folder except `data\` and `.env`: an update replaces everything else,
`models\` included, so keep a detector model of your own elsewhere (`GOLF_ONNX_MODEL` in `.env`).

The steps below are for running from the source code.

## Requirements

- **Python 3.11+**
- **Node.js 20.11+**
- **FFmpeg** on your `PATH` (Windows: `winget install Gyan.FFmpeg`, macOS: `brew install ffmpeg`,
  Linux: `apt install ffmpeg`)
- A graphics card makes analysis and export faster, but is not required. On Windows the ball
  detector uses any GPU through DirectML (NVIDIA, AMD, Intel); no PyTorch or CUDA needed.

## Getting started

### Windows

1. Double-click **`setup.bat`**. It creates the Python environment, installs packages, downloads the
   ball detector (RF-DETR as ONNX, 120 MB), prepares the database and copies `.env.example` to `.env`.
2. Double-click **`start.bat`**. The first time (and after a `git pull`), the web app is built – about
   a minute. The browser then opens at <http://localhost:3000>.
3. Click **"Try a sample video"** or upload your own.

Close the window to stop the app. When another program already uses port 3000 or 8000, `start.bat`
(and the installed app) pick free ports and say so in the window; starting it a second time only
opens the browser on the running copy.

### macOS / Linux

```
./setup.sh
npm run build && node scripts/dev.mjs --prod --open
```

Stop it with Ctrl+C. Run `npm run build` again after pulling new code.

Your data (database, videos, exports) lives in `data/`.

## No login – it only listens on this PC

Open Golf Tracer is for the person at the PC it runs on: there are no accounts, no sign-up and no
login. Open it and start. Because anyone who can reach the app can see and change every project,
it only listens on `127.0.0.1` by default, so other devices cannot reach it.

### Use it from another device on your network / a GPU PC

Want to edit from your laptop while a desktop with a big GPU does the work? Run the app on the
GPU PC and open it to your network in its `.env`:

```
LISTEN_HOST=0.0.0.0
```

Then open `http://<ip-of-that-pc>:3000` on the other device. Opening it by a name instead of an IP
(e.g. `http://mypc.local:3000`)? Add the name: `ALLOWED_HOSTS=mypc.local` (comma separated for
several). Other names are refused.

> **Warning:** there is still no login. Everyone on the network can see, change and delete all
> projects. Only do this on a network you trust (your home network) – never on public Wi-Fi or
> directly on the internet. The API itself always stays on `127.0.0.1`; the web app proxies to it.

## Security and privacy

- **Other programs and users on this PC can reach it.** `127.0.0.1` keeps other devices out, but
  any program or Windows/macOS/Linux user account on the same PC can open the app and its API
  (`127.0.0.1:8000`) – there is no login. Don't run it on a PC shared with people you don't
  trust. Web sites in your browser can't: writes from other sites are refused, and so are host
  names other than localhost, IP addresses and `ALLOWED_HOSTS` (DNS rebinding).
- **Secrets on disk.** The AI key and the ChatGPT sign-in tokens are kept in the database in
  `data/`. On Windows they are encrypted with DPAPI for your Windows user (a copied database or
  backup can't be read elsewhere, and after moving to another PC you enter the key or sign in
  again). On macOS/Linux they are stored as plain text, as are `AI_API_KEY` in `.env` and the
  app's own keys in `data/.secret` and `data/.internal-token` on every OS: they are protected
  only by the permissions of your user folder. Keys never reach the browser, logs, projects or
  the data export.

### What leaves your PC

Videos, projects and exports stay on your PC. These are the only things sent elsewhere:

| What | To | When |
|---|---|---|
| A video's GPS position | OpenStreetMap's public Overpass servers (`overpass-api.de`, `maps.mail.ru`, `overpass.kumi.systems`) | During each analysis of a video with GPS, to find the course, hole and distance to the green. Turn it off under **Settings → Privacy** ("Look courses up on OpenStreetMap") or with `GEO_LOOKUP=0` |
| The map position / your search text | Overpass and Nominatim (`nominatim.openstreetmap.org`) | When you open "Measure on the map" or search in it |
| Map tiles for the area shown | `tile.openstreetmap.org`, satellite tiles from Esri (`server.arcgisonline.com`) | Loaded by your browser while the map is open |
| A text summary of the round (project and course name, date, hole, club and distances per shot – never videos or file names) and your wish for the video | The AI provider you chose (OpenAI-compatible, Anthropic, ChatGPT; nothing with Ollama on your own PC) | Only with "Make a video for me" and an AI provider chosen. With still frames (`AI_VISION` / Settings → AI) a few frames from the green are sent too |
| Sign-in and token refresh | OpenAI (`auth.openai.com`, `api.openai.com`) | Only with "ChatGPT (your plan)". The tokens stay on the server |
| A download of the ball-detection model | GitHub (this repository's releases) | Once, if `models/` doesn't have it yet |
| The app's version (in the `User-Agent`) when asking for the newest release | GitHub (`api.github.com`) | At most once a day, from the API (not your browser). Turn it off under **Settings → About** ("Check for new versions"), see [docs/privacy.md](docs/privacy.md) |

There is no telemetry (Next.js and Hugging Face telemetry are switched off).

## Configuration

Everything has sensible defaults, and nothing has to be set. To change something, edit `.env`
(setup copies it from [`.env.example`](.env.example), which explains every option):

| Variable | What it does |
|---|---|
| `DATA_DIR` | Where the database, videos and exports are stored (default `./data`) |
| `MAX_UPLOAD_BYTES`, `MAX_VIDEO_SECONDS` | Largest upload (default 20 GB) and longest video (default 2 hours) |
| `GOLF_DETECTOR` | Ball detector: `rfdetr` (default, ONNX), `rfdetr-torch`, `yolo` or `blob` |
| `GOLF_HDR_TONEMAP` | `1` tone-maps HDR videos to SDR before analysis |
| `PROXY_CODEC` | Editor preview codec: `h264` (default) or `vp9` |
| `INGEST_PARALLEL` | Videos prepared at once (preview, thumbnails, waveform); overrides **Settings → Performance**, whose default is 2, or 1 on PCs with 4 CPU cores or fewer |
| `EXPORT_CPU` | `1` forces CPU encoding even when a GPU encoder exists |
| `NEXT_PUBLIC_MAP_SATELLITE` | Satellite map in "Measure on map": empty = auto, `1` = always, `0` = never |
| `LISTEN_HOST`, `ALLOWED_HOSTS` | Network access, see above |
| `GEO_LOOKUP` | `0` never looks courses up on OpenStreetMap from a video's GPS, see [What leaves your PC](#what-leaves-your-pc) |
| `LOG_LEVEL` | `INFO` by default |
| `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MAX_TOKENS`, `AI_VISION` | Optional AI model for "Make video for me", see below |

Restart the app after changing `.env` (rebuild with `npm run build` after changing a
`NEXT_PUBLIC_` variable).

### Performance

**Settings → Performance** chooses how much of the PC the analysis may use – no restart, it applies
from the next job:

- **Gentle** – half the CPU cores, one analysis and one video at a time: the PC stays usable.
- **Balanced** (default) – all cores for one analysis at a time.
- **Max** – several analyses and videos at once (on a GPU: 3 with ≥ 10 GB graphics memory, 2 with ≥ 6 GB).
- **Tuned for this PC** – made by **Optimise**, a 30–60 s benchmark of the ball detector (frames per call,
  sessions on CUDA, analyses sharing it) and, on a GPU, of decoding videos side by side – most of an
  analysis once the detector runs on the GPU. Each step stops at an error, at 80 % of the graphics memory,
  or when it gets no faster. It shows the result, e.g. "≈ 1.6× faster ball finding than Balanced; GPU:
  RTX 5070 – use up to 3 analyses at once", and every step it tried under "Details". It waits for running
  analyses and can be stopped.

If an analysis runs out of memory or loses the GPU, it is retried once with the next lower profile, which
is then kept (shown in the same place). Stored in `data/performance.json`.

### AI for "Make video for me" (optional)

Everything works without AI. With a model it reads your preference, words the questions better and
writes the title, texts and an upload description. The model only sees **a text summary** of the
round (one line per clip and per shot), never video; at most 2 calls per video. Still frames only if
you turn that on (`AI_VISION`, below).

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `none` | `none` (fixed rules), `ollama` (local, nothing leaves the PC), `openai-compatible` (OpenAI, OpenRouter, LM Studio …) or `anthropic` (ChatGPT plan: in the app only, see below) |
| `AI_MODEL` | provider default | e.g. `llama3.1`, `gpt-4o-mini`, `claude-haiku-5-5` |
| `AI_BASE_URL` | provider default | e.g. `http://localhost:11434/v1` (Ollama), `http://localhost:1234/v1` (LM Studio), `https://openrouter.ai/api/v1` |
| `AI_API_KEY` | – | Never sent to the browser, logged, or stored in projects or the data export |
| `AI_MAX_TOKENS` | `20000` | Token ceiling for the plan calls of one video (in + out); above it the plan is made by fixed rules and a note says why – the video is still made. Settings → AI shows about how many tokens a full round needs |
| `AI_VISION` | `0` | `1` = when the putt count on a hole is unsure, the model looks at up to 8 still frames from the green instead of asking you: taken at each putt the analysis found (strike, where the ball stopped, 1 s after the last) and cropped around ball, cup and player (max 768 px). The model answers simple questions per frame and the app counts. Needs a model that can see images (Ollama's default `llama3.1` cannot: use e.g. `llama3.2-vision`); one call per hole, at most 6 per video, up to about 7 000 tokens each, from a separate allowance of 30 000 tokens on top of `AI_MAX_TOKENS`. With Ollama the frames stay on the PC; with a cloud provider they are sent there. Answers below 0.7 confidence are asked as usual |

The same can be chosen in the app under **Settings → AI** (with "Test connection"); otherwise the
`.env` defaults are used. Token usage is shown when the video is done.

With **Ollama** the app talks to Ollama's own API (`/api/chat`, the `/v1` in the address is fine) and
sets the context window (`num_ctx`) to what the round needs: Ollama's default of 2–4k tokens would
silently cut a whole round short. If you point other tools at Ollama's OpenAI endpoint, set
`OLLAMA_CONTEXT_LENGTH=16384` (or more) on the Ollama server for the same reason. OpenAI's reasoning
models (`gpt-5`, `o3`, `o4-mini` …) work too: they get `max_completion_tokens` and no temperature.

A request that timed out is never sent again (the provider may already have billed it; its tokens
are counted), and a video that has to be made again after a later error reuses the plan the AI
already made – `AI_MAX_TOKENS` is per video, not per attempt.

Without AI (and with it), a made video gets a **text for YouTube**: a description from the facts of the
round (course, day, score, highlights – or the AI's description) and chapters with exact times from the
timeline (`0:00 Intro`, `1:12 Hul 1 – par 4 – birdie` …). It is shown when the video is done, in the
export dialog and under My videos, with a **Copy for YouTube** button.

#### Use your ChatGPT plan (Sign in with ChatGPT, preview)

Instead of an API key you can let "Make video for me" use your ChatGPT Plus/Pro plan, through
OpenAI's [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)
(a preview). It is chosen in the app only, not in `.env`.

1. **Settings → AI → Provider: ChatGPT (your plan)**, then **Continue with ChatGPT**. A new tab opens at OpenAI.
2. Sign in, name the app if asked, and allow it to use your ChatGPT plan.
3. OpenAI sends you back to `http://127.0.0.1:8000/api/ai/chatgpt/callback`, which returns you to Settings.
   This only works in a browser **on the PC that runs Open Golf Tracer** (also when you normally use it
   from another device).
4. Pick a model from your account's list, **Save**, and **Test connection**.

What it sends: the round's text summary (and still frames from the green, only if you turned that on)
goes to OpenAI and counts against your ChatGPT plan; `AI_MAX_TOKENS` still applies. Review or limit what
the app may use under [ChatGPT settings → Usage](https://chatgpt.com/settings/usage); when a limit is
reached the video stops with a message that links there. The tokens stay on the server (never in the
browser, logs or the data export) and are renewed automatically; **Sign out** revokes them. If the sign-in
expires or you disconnect the app in ChatGPT, sign in again.

## Features

- **Analysis:** every shot in a video is found from the strike sound + ball detection (also without
  audio), the ball is tracked in flight and a physical trajectory is fitted. Progress is shown live.
- **Tracer editing:** drag the start, apex and landing; set club, carry, curve, flight time and timing.
  The physics refits in under 16 ms. Six styles + your own presets; the default looks like modern
  shot tracer clips (soft start, red to gold).
- **Hole and course from GPS:** the video's location is looked up in OpenStreetMap – course, hole, par
  and distance to the green. The distance keeps the estimate realistic (an approach shot can't become 250 m).
- **Measure on map:** the tee is taken from the video's GPS and the landing is suggested along the hole;
  click or drag, and the distance becomes the shot's carry. The hole can be shown as a graphic (course map).
- **Whole round:** pick several clips at once and they are merged into one project in the order they
  were filmed.
- **Make video:** one click gives a finished YouTube video (title, hole info, numbers, course map;
  vertical clips on a blurred background), one highlight short of all shots, or one short per shot –
  each as a new project.
- **Make video for me:** pick clips and write freely what you want ("YouTube video of the round, only
  good shots, calm style"). The app plans and cuts the video itself. When in doubt (uncertain flights,
  clips without shots or recording time, clips without GPS, possible retakes, the same shot from two
  angles) it asks once, with a default answer for every question. Works entirely without AI, or with an
  optional AI model (Ollama, OpenAI-compatible or Anthropic) that sees a text summary (and, only if you
  turn it on, a few still frames from the green when the putt count is unsure); also from
  the command line (see below).
- **Graphics:** text, titles, stat cards, lower thirds, shapes, images/logos, with keyframes and
  in/out animations. Templates (Range session, Minimal, TV broadcast, Hole in one, Swing, Neon).
- **Timeline:** multiple tracks, trim, split, ripple, speed, freeze frame, audio and music.
- **Formats:** 16:9, 9:16, 1:1, 4:5 with automatic reframing that follows the ball, or the whole video
  on a blurred copy of itself.
- **Export:** presets for Shorts/Reels/TikTok, YouTube 1080p/4K and original; 30/60 fps; HDR kept or
  tone-mapped; queue with progress.
- **Performance:** Gentle, Balanced or Max, or **Optimise** to measure what this PC can safely run
  (detector sessions, analyses at once, within 80 % of the graphics memory); out-of-memory errors step it down.
- **Settings:** language, units, theme and a data export of all your projects. Every feature is free.
- English and Danish, light and dark theme, keyboard shortcuts (`?` in the editor), WCAG AA.

## Backup and restore

Everything the app keeps is in its data folder: `%LOCALAPPDATA%\Programs\Open Golf Tracer\data`
for the Windows installer, `data/` in a source checkout. **Settings → About** shows the path and
opens it.

- **Back up:** stop the app (close the black window, or Ctrl+C), then copy the whole `data` folder
  to another disk or a cloud folder. It holds the database (projects, settings), the uploaded
  videos, exports and logs. Keep the copy private: the AI key and the ChatGPT sign-in, if you set
  them up, are stored in the database too.
- **Restore:** stop the app, put the copied `data` folder back in place of the current one, and start
  the app. Use the same or a newer app version than the one that made the copy; a newer version
  updates the database by itself when it starts.
- **Settings → Your data → Download my data** is a JSON export of your projects and settings for
  reading or moving to another tool. It is not a backup: it has no videos and cannot be imported
  back into the app.

## Logs, bug reports and updates

- The launcher writes everything the app prints to `data/logs/app-YYYYMMDD.log` (the last 7 days are
  kept), so the messages are still there after the window is closed. Keys and tokens are masked.
- Found a bug? **Settings → About → Save diagnostics** saves a zip with the version, your PC
  (OS, GPU, FFmpeg), the performance settings, recent log lines and job summaries, with keys and
  tokens removed. Attach it to a [bug report](https://github.com/nicklashn/open-golf-tracer/issues/new?template=bug.yml).
  Security problems: see [SECURITY.md](SECURITY.md).
- Once a day the app asks GitHub whether a newer version exists and shows a small banner if so.
  Turn it off under **Settings → About**. What is sent: [docs/privacy.md](docs/privacy.md).
- What changed in each version: [CHANGELOG.md](CHANGELOG.md).

## Licence

Open Golf Tracer is open source under the **MIT licence** – see [LICENSE](LICENSE). You may use,
modify, share and build on the code, commercially too. Contributions are welcome: see
[CONTRIBUTING.md](CONTRIBUTING.md). Third-party licences (including the ball detector – RF-DETR,
YOLO – and how to switch it): [docs/licensing.md](docs/licensing.md).

## Development

```
npm run dev          # API :8000, worker, exporter and web :3000 with hot reload
npm run check        # eslint + prettier + tsc + vitest
npm run test:py      # pytest (lint: .venv/bin/ruff check . && .venv/bin/pyright)
npx playwright test  # parity + e2e (needs the app running on :3000)
```

| Command | Purpose |
|---|---|
| `npm run autovideo -- <folder\|files> [--preference "…"] [--kind youtube\|highlight\|shorts] [--answers answers.json] [--yes] [--export youtube1080]` | "Make video for me" from the command line: uploads, waits for analysis, asks the questions (or `--yes` = default answers), makes the video and can export and download it. Needs the app running. |
| `npm run demo` | Draws the sample video and analyses it |
| `npm run brand` | Favicon, app icons and manifest from the vector sources |
| `npm run gen:schema` | JSON Schema from the zod schema (used by the API for validation) |
| `python scripts/make_static_fonts.py` | Static font versions for the renderer |

Python tests: `.venv/Scripts/python -m pytest` (slow tests with real video decoding: `-m slow`).
Put your own test videos in `videos/` – they are not committed.

How the parts fit together: [docs/architecture.md](docs/architecture.md) (in Danish for now).

## The engine on its own (without the web app)

The original command line still works. Drag one or more videos onto **`Tracer.bat`**, or:

```
.venv\Scripts\python -m shottracer VIDEO [VIDEO ...] [--carry M] [--club CLUB] [--stats] [--color #ffcc00] [--debug]
.venv\Scripts\python -m shottracer.analyze_video VIDEO --out shots.json   # analysis only, as JSON
```

| Option | Meaning |
|---|---|
| `-o PATH` | output file (one video) or output folder |
| `--carry M` | known carry in metres – scales the 3D flight so apex/ball speed fit |
| `--club CLUB` | `driver`, `wood`, `longIron`, `midIron`, `shortIron` or `wedge` – keeps the estimate realistic |
| `--stats` | shows carry / apex / ball speed / launch after landing |
| `--open` | shows the finished video in Explorer |
| `--color #ffcc00` | tracer colour |
| `--ball X,Y` | the ball's position at address, if it isn't found automatically |
| `--impact SEC` | time of impact, if it isn't found automatically |
| `--slowmo F` | the video is F times slower than real time |
| `--no-hold` | don't extend the video so the ball has time to land |
| `--debug` | saves `_debug.png` and `_debug.json` |

Filming tip: put the camera behind the ball (down-the-line) and keep it as still as possible.

The ball detector is RF-DETR Large, exported to ONNX and run with ONNX Runtime (DirectML on Windows,
CPU elsewhere). Setup downloads it to `models/rf-detr-large.onnx` (`python scripts/fetch_model.py`;
the Windows certificate store is used, so antivirus that intercepts HTTPS doesn't block the download).
On the reference clip it gives the same shots and numbers as RF-DETR in PyTorch, which is still
available as `GOLF_DETECTOR=rfdetr-torch` after `pip install -r requirements-torch.txt`
(`scripts/export_onnx.py` makes the ONNX file from it).
The YOLO detector can still be chosen with `GOLF_DETECTOR=yolo` or `--model yolo26x.pt` after
`pip install -r requirements-yolo.txt` (AGPL-3.0, see [docs/licensing.md](docs/licensing.md)).
