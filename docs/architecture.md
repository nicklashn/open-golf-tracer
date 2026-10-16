# Arkitektur

Overblik over, hvordan delene hænger sammen. Datamodellen står i `apps/api/golf_api/models.py`,
projekt-skemaet i `packages/schema` og API-listen på <http://127.0.0.1:8000/api/docs>. Det hele kører
lokalt på din egen PC: SQLite-database og filer i `data/`.

## Monorepo

```
apps/
  web/        Next.js 15 (App Router) + TypeScript + Tailwind 4 + Radix. Projektliste, indstillinger, editor.
  api/        FastAPI + SQLAlchemy 2 + Alembic. Projekter, uploads, jobs, SSE.
  worker/     Python. Ingest (probe, proxy, poster, thumbnails, waveform) og analyse (shottracer).
  exporter/   Node. Eksport: tegner overlay med packages/render og compositerer med ffmpeg.
packages/
  schema/     zod-skema for projektdokumentet + tidslinje-hjælpere; genererer JSON Schema til API'et.
  physics/    Ballistisk model og constrained fit i TypeScript (port af shottracer/physics.py).
  render/     Deterministisk software-renderer: tracer, vektorgrafik, tekst (opentype), lag, skabeloner.
  compose/    Videogeneratorer uden UI: YouTube-video, highlight-short, short pr. slag, lag-standarder.
              Rene funktioner (projekt ind, nyt projekt ud), så både editoren og jobs/CLI kan bruge dem.
shottracer/   Den oprindelige motor (Python): slag-, bold- og flugtsporing + fysik. CLI og Tracer.bat virker stadig.
assets/       Skrifttyper (OFL) og demo-videoen med færdig analyse.
scripts/      dev/start, demo-/brand-/font-generatorer.
tests/        Python-tests, paritetstests og Playwright e2e.
```

## Ét projektdokument

Hele redigeringen er ét JSON-dokument (`packages/schema/src/project.ts`): medier, klip på
tidslinjen, slag (kamera, anker, spor, fysikparametre, bindinger, stil, timing, slow-mo),
grafiklag med keyframes og animationer, lydspor, format/reframing og eksportindstillinger.

- Browseren redigerer dokumentet med immer-patches (fortryd/gentag) og autosaver det med
  optimistisk versionering (`doc_version`); konflikter afvises af API'et.
- API'et validerer hvert gemt dokument mod det genererede JSON Schema – samme kontrakt som
  browser og exporter bruger.
- Analyseresultater gemmes separat (`projects.analysis`) og flettes ind i dokumentet, når
  editoren åbner det, så en ny analyse aldrig overskriver brugerens rettelser.

## Fysik: samme tal i Python og TypeScript

Banen er en 3D-boldbane (tyngde, luftmodstand, løft fra backspin, sidespin) set gennem et
kamera med ukendt hældning, højde og brændvidde. Python fitter den til det sporede bold-spor
under analysen. I editoren fitter TypeScript-porten igen live i en Web Worker, når brugeren
trækker i start/top/landing, angiver carry eller kurve:

- Levenberg–Marquardt med aktive grænser, varm λ og et tidsbudget pr. opdatering.
- Robust tab (soft-L1) kun på det sporede spor; brugerens håndtag er hårde bindinger (0,5 px).
- Landingspunktet interpoleres mellem simulationsskridt, så afledte er glatte under træk.
- Paritet: `packages/physics/test/parity.test.ts` sammenligner med fixtures genereret af Python (≤ 0,5 px).

## Rendering: preview = eksport

`packages/render` tegner alt overlay (tracer, tekst, statistik-kort, figurer, billeder,
vandmærke) i ren TypeScript til en RGBA-buffer – ingen Canvas-tekst eller -skygger, som
varierer mellem browsere og Node. Tekst er glyf-konturer fra statiske fonte, så
browser og exporter giver bit-identiske pixels (`tests/parity`, maks. afvigelse 0).

- **Preview:** `<video>` pr. medie (proxy) placeres med CSS-transform for beskæring/reframing;
  overlayet tegnes oven på i et canvas med dirty-rects. Tidslinjens ur håndterer klip, hastighed,
  freeze frames og slow-mo.
- **Eksport:** exporteren bygger en ffmpeg-filtergraf ud fra samme tidslinje (trim, setpts,
  tpad, crop-keyframes, skalering, lyd-mix, HDR/tonemap), renderer kun det område, overlayet
  faktisk bruger, og pipe'r det ind i ffmpeg, som lægger det på originalen. HDR bevares som
  HEVC 10-bit, ellers H.264; hardware-encodere bruges når de findes.

## Jobs

Jobs ligger i databasen (`jobs`-tabellen). Workers claimer atomisk med en betinget UPDATE,
sender heartbeats og får automatisk genforsøg med backoff. Jobs, hvis worker forsvinder,
sættes i kø igen (`maintenance.py`). Fremskridt sendes til browseren med Server-Sent Events
(`/api/events`).

| Bane | Hvem | Jobs |
|---|---|---|
| `media` | Python-worker | `ingest`: probe, poster, proxy (kort GOP), thumbnail-sprite, waveform |
| `analysis` | Python-worker | `analyze`, `retrack` (shottracer.analyze) |
| `export` | Node-exporter | `export` via `/api/internal` (beskyttet af `INTERNAL_TOKEN`) |
| `compose` | Node-exporter (egen bane, så en lang eksport ikke blokerer) | `compose`: "Lav video for mig" (se nedenfor) |

Et job kan også parkeres med status `awaiting_answers` (ingen worker holder det imens) og
sendes tilbage i køen med `POST /api/jobs/{id}/answers`; `defer` sætter et job i kø igen
senere uden at tælle det som et forsøg (bruges, mens en video venter på analysen).

## Lav video for mig

Brugeren vælger klip og skriver en præference. Jobbet `compose` kører i exporteren
(`apps/exporter/src/compose-job.ts`) og bruger `packages/compose`:

1. Venter, til projektets `ingest`/`analyze`-jobs er færdige (`defer`).
2. `summarize(doc)` → `RoundSummary`: én linje pr. klip og pr. slag (id, klip, optagetid, hul/par,
   kølle, carry, confidence, advarsler). Det er det eneste, en AI-model nogensinde ser.
3. `planFromRules(summary, preference)` → `VideoPlan` (zod): format, skabelon-look, hvilke slag,
   rækkefølge, titel, tekster, beskrivelse og spørgsmål med standardsvar. Tvivl findes af faste regler.
4. Er der spørgsmål, parkeres jobbet med dem (`awaiting_answers`). Svarene sendes tilbage sammen
   med samme plan, så den ikke laves igen.
5. `compose(doc, plan, answers)` skjuler fravalgte slag, sætter rækkefølge og huller og kalder de
   samme generatorer som "Lav video". Hver video gemmes som et nyt projekt (`/internal/jobs/{id}/derive`);
   originalen røres ikke.

Webappen viser det i vinduet "Lav video for mig" (fremskridt via SSE); `npm run autovideo` gør det
samme fra kommandolinjen via det offentlige API (upload, jobs, eksport).

### Valgfri AI-model

`packages/compose/src/ai.ts`: AI'en tænker, koden arbejder.

- Modellen får kun `summaryText(summary)`, brugerens tekst, regel-planen og (andet kald) svarene.
  Aldrig video eller projektdokumentet.
- Valgfrit (`AI_VISION` / Indstillinger → AI, slået fra som standard): er analysen i tvivl om antallet af
  putts på et hul (spørgsmålet `putts:<hul>`), tager exporteren 6 JPEG-stillbilleder (maks. 768 px) af
  greenen med ffmpeg direkte til hukommelsen (`frames.ts`), og `resolvePuttsWithVision` (`vision.ts`) spørger
  modellen om `{putts, holed, confidence}`. Ét kald pr. hul, maks. 6 pr. video, i samme token-loft (med plads
  til kaldet efter svarene). Ved confidence ≥ 0,7 udfyldes svaret og spørgsmålet fjernes (med en note);
  ellers – eller ved fejl, f.eks. en model uden billeder – spørges brugeren som før.
- Fast systemprompt først i hvert kald (prompt caching; Anthropic får `cache_control`), uden dynamisk indhold.
- Svaret er en lille JSON-plan (structured output, hvor udbyderen kan), som `mergeAiPlan` lægger oven på
  regel-planen inden for rammerne: kun slag fra regel-planen, samme spørgsmål og valgmuligheder (kun
  ny ordlyd/standard), kun tilladte skabeloner. Valideres med zod.
- Højst 2 kald pr. video: planen, og ét mere efter svarene, hvis der var spørgsmål. Ugyldigt svar → ét
  nyt forsøg med valideringsfejlen; fejler det igen, bruges regel-planen med en note.
- Tokens tælles pr. job (også hen over ventetiden på svar) og logges; over `AI_MAX_TOKENS` stopper jobbet
  med en tydelig fejl, før kaldet sendes.
- Adaptere på ren `fetch`: OpenAI-kompatibel (`/chat/completions`, JSON-schema med fald tilbage til
  JSON-mode) og Anthropic Messages API (`/v1/messages`, effort `low`). Timeout, ét retry ved netværksfejl,
  tydelige fejl (afvist nøgle, ukendt model, Ollama kører ikke).
- Konfigurationen (`.env` eller brugerens egne indstillinger i tabellen `ai_settings`) hentes af exporteren
  via `/internal/jobs/{id}/ai`. Nøglen vises kun maskeret og er ikke med i `public_user` eller dataeksporten.
- "Test forbindelse" er et lille `ai_test`-job i compose-banen.

## Upload

Chunked og genoptagelig: klienten sender bidder (8 MB) med indeks; serveren fører en bitmap
over modtagne bidder, så en afbrudt upload fortsætter, hvor den slap. Når filen er samlet,
valideres den med ffprobe (format, varighed, størrelse mod serverens grænser) og flyttes til lageret.

## Ingen login

- Appen er et enkeltbruger-værktøj uden konti, login, e-mail eller admin. Alle forespørgsler
  handler som én intern "lokal bruger" (`golf_api/deps.py: local_user`), så `user_id`-nøglerne på
  projekter, medier og eksporter stadig virker. Det er den tidligst oprettede bruger i databasen
  (en ældre database beholder dermed sine projekter); findes ingen, oprettes den ved første kald.
- Adgangskontrol er netværket: web og API lytter kun på 127.0.0.1, medmindre `LISTEN_HOST`
  åbner web-appen (se README, "Use it from another device"). API'et afviser skrivende forespørgsler fra
  andre websider (`Sec-Fetch-Site`/`Origin`, `main.py`). `/api/internal` kræver `INTERNAL_TOKEN`.
- Alle funktioner er med. De eneste grænser er største upload og længste video
  (`MAX_UPLOAD_BYTES`, `MAX_VIDEO_SECONDS` i `.env`); de håndhæves af API'et.

## Motoren (shottracer)

1. Slaglyd giver kandidater; RF-DETR (eller YOLO/blob-detektoren) bekræfter bolden før og fravær efter.
   Uden lyd skannes videoen efter bolde ved opstilling.
2. Tre-billeds-differens finder små objekter i bevægelse; en kæde-tracker (numba) finder den
   glatteste kæde fra bolden.
3. Fysikken fittes til sporet og giver banen helt til landing samt carry/apex/boldfart.
4. `analyze()` returnerer alle slag som projekt-JSON; `process()` renderer stadig en video direkte
   (CLI og `Tracer.bat`).

## Hul, bane og runder

- **GPS → sted:** upload læser telefonens position og optagetid fra filen (`probe.py`). Analyse-jobbet
  slår stedet op (`routes/geo.py`: Overpass/OpenStreetMap, cache i `data/cache/osm`) og matcher hele
  hullets linje (tee → green); ved en green vinder et teested, der ligger næsten lige så tæt.
  Afstanden til green sendes som `max_carry` til motoren, der lægger banen efter hullet, hvis
  estimatet er længere, og behandler slag tæt ved green som kortspil.
- **Runder:** en video uploadet til et eksisterende projekt skrives ikke ind i dokumentet (en åben
  editor ville få en versionskonflikt). Den gemmes som `attach` i `project.analysis` og flettes ind i
  optagerækkefølge ved indlæsning (`merged_document`); en åben editor tilføjer den live via job-events.
- **Lav video** (`apps/web/src/editor/generate.ts`) bygger et nyt projekt ud fra slagene: YouTube-klip
  (16:9, `format.fill = 'blur'` for lodrette klip) eller én highlight-short, med lag fra editorens
  standarder. Den originale tidslinje røres ikke.

## Ydelse

Budgetterne: analyse ≤ videoens længde på GPU, live-refit < 16 ms, overlay-render < 16,7 ms pr.
1080p-frame og eksport ≈ realtid.
