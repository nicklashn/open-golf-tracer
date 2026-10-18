# Privacy: what leaves your PC

Open Golf Tracer runs on your own PC, and your videos and projects stay there. The README's
[*What leaves your PC*](../README.md#what-leaves-your-pc) section is the full list (the video's GPS
position goes to OpenStreetMap's Overpass during analysis unless you turn that off under
**Settings → Privacy** or with `GEO_LOOKUP=0`; the AI summary only with an AI provider chosen;
the update check below); this page adds the details that belong to supportability.

- **Update check (on by default, can be turned off).** At most once a day the app's API (not your
  browser) asks GitHub for the newest release:
  `GET https://api.github.com/repos/nicklashn/open-golf-tracer/releases/latest`. The request carries
  the app's version in its `User-Agent` (`open-golf-tracer/<version>`) and, like any web request, your
  IP address; nothing about your PC, projects or videos. When a newer version exists, a small banner
  links to the release page. Turn it off under **Settings → About → Check for new versions**; the
  choice is kept in `data/update-check.json`.
- **Log files stay local.** The launcher writes what the app prints to `data/logs/app-YYYYMMDD.log`
  (7 days are kept). Keys, tokens and anything shaped like them are replaced by `[redacted]` before
  a line is written.
- **The diagnostics file only leaves your PC if you send it.** *Settings → About → Save diagnostics*
  saves a zip (version, OS, GPU, FFmpeg version, performance settings, recent log lines, job
  summaries) to your Downloads folder. Keys and tokens are removed and no videos or project
  documents are included, but log lines can contain file names and paths, so look through it
  before attaching it to a public bug report.
