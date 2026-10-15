# Licenser

Kort version: **Open Golf Tracer er open source under MIT-licensen ([LICENSE](../LICENSE)).** Alle
må bruge, ændre, dele og sælge koden, også i lukkede produkter, så længe copyright- og licens-
teksten følger med. Alle afhængigheder i standardinstallationen har tilladende licenser, der er
forenelige med det. Gennemgået 2026-10-14 (alle Python- og npm-pakker, se afsnit 5).

## 0. Projektets licens

- `LICENSE` indeholder MIT-teksten, og alle `package.json` har `"license": "MIT"`.
- Bidrag modtages under samme licens (se [CONTRIBUTING.md](../CONTRIBUTING.md)).
- GPL/AGPL-pakker må ikke komme med i standardinstallationen. Derfor ligger den valgfri
  YOLO-detektor (`ultralytics`, AGPL-3.0) i en separat `requirements-yolo.txt`.
- Der er ingen hemmeligheder, modelvægte eller private videoer i repoet. Demovideoerne er
  tegnet af `scripts/make_demo.py`.

## 1. Bolddetektoren (RF-DETR, Apache 2.0)

`shottracer/detect.py` bruger som standard **RF-DETR Large** fra Roboflow (`rfdetr`-pakken),
fortrænet på COCO. Kode og vægte for størrelserne Nano–Large er Apache 2.0 og må bruges
kommercielt. (XL/2XL ligger i `rfdetr[plus]` under PML 1.0 og bruges ikke.) Vægtene hentes
til `~/.roboflow/models` ved setup eller første analyse.

På referenceklippene (2026-10-14) gav RF-DETR præcis samme slag og tal som YOLO. D-FINE og
RT-DETRv2 (også Apache 2.0) blev testet og fravalgt: de meldte falske slag, når golferen samlede
tee'en op.

| Detektor | Vælges med | Licens | Kvalitet |
|---|---|---|---|
| `RfDetrBallDetector` | standard (`GOLF_DETECTOR=rfdetr`) | Apache 2.0 | Som YOLO på vores klip; finder også golfspilleren |
| `YoloBallDetector` | `GOLF_DETECTOR=yolo` eller `--model yolo26x.pt` | AGPL-3.0 / Enterprise | Reference; ca. 5.000 $/år for Enterprise (kun tilbud) |
| `BlobBallDetector` | `GOLF_DETECTOR=blob` | ingen ekstra (OpenCV, Apache 2.0) | Klassisk billedbehandling; god på rolige baner, svagere i rodede scener |

Interfacet er `BallDetector` (metoderne `ball(frame, golfer)` og `people(frame)`); en anden
model sættes ind med `GOLF_DETECTOR=<modul>:<klasse>`. Selve sporingen i flugt (`track.py`),
fysikken og traceren bruger ingen af modellerne.

`ultralytics` er **ikke** med i standardinstallationen. Vil man sammenligne med YOLO (eller køre de
syntetiske tests på YOLO), installeres den med `pip install -r requirements-yolo.txt`. Den er
AGPL-3.0, så den hører ikke til i en installation, der videregives under MIT-vilkår.

## 2. FFmpeg

FFmpeg selv er LGPL-2.1+, men de gængse builds (Gyan, BtbN, Homebrew, apt) er bygget med
`--enable-gpl` og indeholder x264/x265 (GPL). Appen **kalder `ffmpeg`/`ffprobe` som separate
programmer** og linker ikke til dem, så appens egen kode bliver ikke GPL. Distribuerer man
selv FFmpeg-binæren sammen med appen, skal GPL-vilkårene for den binær overholdes (kildekode-
tilbud, licenstekst). Repoet indeholder ingen FFmpeg-binær; man installerer den selv.

**Windows-installeren** (`installer/`) medbringer gyan.dev's "release essentials"-build (GPL-3.0)
i `runtime\ffmpeg` sammen med dens `LICENSE` og `README.txt`, som peger på kildekoden og
build-opskriften. Det er en separat binær ved siden af appen (aggregation), så MIT-koden påvirkes
ikke. Node.js (MIT) og Python (PSF, python-build-standalone) følger også med; PyTorch (BSD) hentes
under installationen.

H.264/HEVC er desuden patentbelagte formater (MPEG LA/Access Advance). Hardware-encoderne
(NVENC, Quick Sync, VideoToolbox) er licenseret via hardwaren/OS'et.

## 3. Skrifttyper (SIL Open Font License 1.1)

Inter, Oswald, Bebas Neue, Barlow Condensed og Playfair Display ligger som statiske,
Latin-subsettede udgaver i `assets/fonts/static` (lavet med fonttools fra de officielle
variable fonte). OFL tillader at indlejre dem i apps og at brænde tekst med dem ind i videoer.
Subsettede udgaver er "Modified Versions" og må ikke bære et reserveret fontnavn. Playfair
Display har Reserved Font Name "Playfair Display", så vores subset hedder internt
**GT Serif Display** og vises som "Serif Display" i appen. De øvrige fire har ingen reserverede
navne. Licensteksterne ligger ved siden af filerne (`assets/fonts/*-OFL.txt` og i `static/`).

## 4. Kort (Mål på kort / banekort)

- **Banedata** (fairways, greens, bunkere, huller) hentes fra OpenStreetMap via Overpass og
  søgning via Nominatim, gennem API'et (`/api/geo/*`) med cache i `data/cache/osm`. Data er
  **ODbL**: grafikken skal kreditere "© OpenStreetMap" (banekortet gør det selv). Begge tjenester
  er gratis og beregnet til let brug, som passer til én person på egen PC.
- **Kortfliser i editoren:** OpenStreetMap's egne fliser (`tile.openstreetmap.org`) må bruges
  interaktivt med kreditering, men ikke til tung trafik. **Satellitbilleder** kommer fra Esri
  World Imagery, hvis vilkår kræver en ArcGIS-konto/licens til kommerciel brug. Lokalt til eget
  brug er begge i orden, og satellitknappen vises derfor som standard kun på localhost og
  hjemmenetværket (`NEXT_PUBLIC_MAP_SATELLITE`).
- *Note:* gør man appen tilgængelig for mange andre, skal man selv sørge for kortadgang med licens
  (egen Overpass, og fliser fra fx MapTiler, Stadia eller Esri med konto).
- Videoens GPS-position læses fra filens metadata og sendes kun til kortet/OSM, når man selv
  åbner "Mål på kort".

## 5. Øvrige afhængigheder

| Pakke | Licens |
|---|---|
| Next.js, React, Radix UI, Tailwind CSS, zustand, immer, zod, clsx, tailwind-merge, class-variance-authority | MIT |
| lucide-react | ISC |
| Leaflet (kort i editoren) | BSD-2-Clause |
| opentype.js, @napi-rs/canvas, esbuild, tsx | MIT |
| FastAPI, Starlette, Pydantic, SQLAlchemy, Alembic, uvicorn, httpx, jsonschema | MIT / BSD |
| NumPy, SciPy, numba, PyTorch | BSD |
| OpenCV (opencv-python-headless) | Apache 2.0 |
| Playwright | Apache 2.0 (kun test) |
| axe-core, lightningcss | MPL-2.0 (kun test/build, ikke med i produktet) |
| sharp (billeder i Next.js) | Apache 2.0; den medfølgende libvips er LGPL-3.0, indlæst som separat bibliotek |
| PyAV | BSD-3-Clause; hjulene indeholder FFmpeg-biblioteker under LGPL |
| certifi, tqdm | MPL-2.0 (uændret brug er uproblematisk) |
| caniuse-lite (via Next.js/browserslist) | CC-BY-4.0 (data) |
| @fontsource-variable/inter | SIL OFL 1.1 |

Fuld gennemgang 2026-10-14: ingen GPL-, AGPL- eller "ikke-kommerciel"-licenser i
standardinstallationen (kun `ultralytics` i den valgfri `requirements-yolo.txt`). RF-DETR's
afhængigheder (transformers, huggingface_hub, supervision, safetensors) er Apache 2.0/MIT.
Tjek igen ved nye pakker: `npx license-checker --production --summary` og `pip-licenses`.

## 6. Eget indhold

Mascotten Birdie, logoet, ikonerne, demo-videoen (tegnet af `scripts/make_demo.py`) og
teksterne er lavet til dette projekt og er udgivet under MIT-licensen ligesom koden. Der er ingen
stock-billeder eller -videoer i repoet.
