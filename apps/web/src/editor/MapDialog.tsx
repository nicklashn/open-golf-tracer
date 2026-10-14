'use client';

import 'leaflet/dist/leaflet.css';
import { Map as MapIcon, Search } from 'lucide-react';
import type { GeoPoint, Shot } from '@golf/schema';
import type * as Leaflet from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Segmented, Switch } from '@/components/ui/controls';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useI18n } from '@/lib/i18n/client';
import { M_TO_YD } from '@golf/schema';
import { shotStats } from '@golf/render';
import { haversine, holeTitle, placeTitle, suggestLanding, type CourseData } from './course';
import * as ops from './ops';
import { useEditor } from './store';

const COLORS: Record<string, string> = {
  fairway: '#5a9e4b',
  green: '#7cc96a',
  tee: '#66ad55',
  bunker: '#e6d9a8',
  water: '#3f82bf',
  woods: '#1f4026',
  rough: '#3b6e3a',
};

const TILES = {
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, attribution: '© OpenStreetMap contributors' },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    max: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
};

/**
 * Esri's satellite imagery needs a paid licence in a public app, so it is only offered when the
 * app runs on this machine or the home network. NEXT_PUBLIC_MAP_SATELLITE=1 turns it on online
 * (once a licensed provider is set up), =0 turns it off everywhere.
 */
function satelliteAllowed(): boolean {
  const flag = process.env.NEXT_PUBLIC_MAP_SATELLITE;
  if (flag === '1' || flag === '0') return flag === '1';
  if (typeof window === 'undefined') return false;
  const h = window.location.hostname;
  return h === 'localhost' || h.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

const pin = (L: typeof Leaflet, color: string, label: string) =>
  L.divIcon({
    className: '',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    html: `<div style="width:26px;height:26px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font:700 11px Inter,sans-serif;color:#111">${label}</div>`,
  });

/**
 * "Measure on the map": the tee starts where the phone recorded the video (GPS in the file);
 * click where the ball landed. The distance becomes the shot's carry, and the course from
 * OpenStreetMap can follow the shot as a graphic.
 */
export function MapDialog({ shot, open, onOpenChange }: { shot: Shot; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t, f, locale } = useI18n();
  const T = t.map;
  const units = useEditor((s) => s.doc.units);
  const mediaGeo = useEditor((s) => s.doc.media[shot.mediaId]?.geo ?? null);
  // Without GPS in this clip, start where another clip of the round was filmed (not as the tee).
  const nearby = useEditor((s) => Object.values(s.doc.media).find((m) => m.geo)?.geo ?? null);
  const place = useEditor((s) => s.doc.media[shot.mediaId]?.place ?? null);
  const suggestion = suggestLanding(place, shotStats(shot)?.carryM);
  const hasGraphic = useEditor((s) => s.doc.layers.some((l) => l.type === 'courseMap' && l.props.shotId === shot.id));
  const [tee, setTee] = useState<GeoPoint | null>(shot.geo?.tee ?? mediaGeo);
  const [landing, setLanding] = useState<GeoPoint | null>(shot.geo?.landing ?? suggestion);
  const suggested = !shot.geo && !!landing && !!suggestion && landing.lat === suggestion.lat && landing.lon === suggestion.lon;
  const [base, setBase] = useState<'osm' | 'satellite'>(() => (satelliteAllowed() ? 'satellite' : 'osm'));
  const [graphic, setGraphic] = useState(true);
  const [course, setCourse] = useState<CourseData | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ name: string; lat: number; lon: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  const el = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const lib = useRef<typeof Leaflet | null>(null);
  const tiles = useRef<Leaflet.TileLayer | null>(null);
  const overlay = useRef<Leaflet.LayerGroup | null>(null);
  const shotLayer = useRef<Leaflet.LayerGroup | null>(null);
  const teeRef = useRef(tee);
  teeRef.current = tee;
  const nearbyRef = useRef(nearby);
  nearbyRef.current = nearby;

  useEffect(() => {
    if (open) {
      setTee(shot.geo?.tee ?? mediaGeo);
      setLanding(shot.geo?.landing ?? suggestion);
      setGraphic(true);
    }
  }, [open, shot.geo, mediaGeo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Create the map once the dialog is open (Leaflet needs the DOM, so it loads lazily).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled || !el.current || map.current) return;
      lib.current = L;
      const start = teeRef.current ?? nearbyRef.current;
      const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView(start ? [start.lat, start.lon] : [56.0, 10.0], start ? 17 : 7);
      overlay.current = L.layerGroup().addTo(m);
      shotLayer.current = L.layerGroup().addTo(m);
      m.on('click', (e: Leaflet.LeafletMouseEvent) => {
        const p = { lat: round(e.latlng.lat), lon: round(e.latlng.lng) };
        if (!teeRef.current) setTee(p);
        else setLanding(p);
      });
      map.current = m;
      setReady(true);
      setTimeout(() => m.invalidateSize(), 50);
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      tiles.current = null;
      setReady(false);
    };
  }, [open]);

  // Base layer.
  useEffect(() => {
    const L = lib.current;
    const m = map.current;
    if (!L || !m) return;
    tiles.current?.remove();
    const cfg = TILES[base];
    tiles.current = L.tileLayer(cfg.url, { maxZoom: cfg.max, attribution: cfg.attribution }).addTo(m);
  }, [base, ready]);

  // Course features around the tee (from our API, which asks OpenStreetMap and caches).
  useEffect(() => {
    if (!open || !tee) return;
    let cancelled = false;
    api<CourseData>(`/geo/course?lat=${tee.lat}&lon=${tee.lon}&radius=900`).then(
      (d) => !cancelled && setCourse(d),
      () => !cancelled && setCourse(null),
    );
    return () => {
      cancelled = true;
    };
  }, [open, tee?.lat, tee?.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const L = lib.current;
    const g = overlay.current;
    if (!L || !g) return;
    g.clearLayers();
    for (const f of course?.features ?? []) {
      L.polygon(f.ring, { color: COLORS[f.k], weight: 1, opacity: 0.9, fillOpacity: base === 'osm' ? 0.55 : 0.18, interactive: false }).addTo(g);
    }
    // The hole being played, tee to green, so it is obvious where on the course you are.
    if (place?.line?.length) {
      L.polyline(
        place.line.map(([la, lo]) => [la, lo] as [number, number]),
        { color: '#ffffff', weight: 2, opacity: 0.85, dashArray: '2 6', interactive: false },
      ).addTo(g);
    }
  }, [course, base, ready, place]);

  // Tee, landing and the line between them.
  useEffect(() => {
    const L = lib.current;
    const g = shotLayer.current;
    if (!L || !g) return;
    g.clearLayers();
    if (tee) {
      L.marker([tee.lat, tee.lon], { icon: pin(L, '#ffffff', 'T'), draggable: true, title: T.tee })
        .on('dragend', (e) => {
          const ll = (e.target as Leaflet.Marker).getLatLng();
          setTee({ lat: round(ll.lat), lon: round(ll.lng) });
        })
        .addTo(g);
    }
    if (tee && landing) {
      L.polyline(
        [
          [tee.lat, tee.lon],
          [landing.lat, landing.lon],
        ],
        { color: '#ff3b30', weight: 4, dashArray: '8 6' },
      ).addTo(g);
      L.marker([landing.lat, landing.lon], { icon: pin(L, '#ff3b30', ''), draggable: true, title: T.landing })
        .on('dragend', (e) => {
          const ll = (e.target as Leaflet.Marker).getLatLng();
          setLanding({ lat: round(ll.lat), lon: round(ll.lng) });
        })
        .addTo(g);
    }
  }, [tee, landing, T.tee, T.landing, ready]);

  async function find() {
    if (query.trim().length < 2) return;
    try {
      setResults(await api(`/geo/search?q=${encodeURIComponent(query.trim())}`));
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }

  function goTo(r: { lat: number; lon: number }) {
    map.current?.setView([r.lat, r.lon], 16);
    setResults([]);
  }

  const dist = tee && landing ? haversine(tee, landing) : null;
  const distTxt = dist == null ? '–' : units === 'yd' ? `${Math.round(dist * M_TO_YD)} yd` : `${Math.round(dist)} m`;

  async function apply() {
    if (!tee || !landing) return;
    setBusy(true);
    try {
      const title = placeTitle(place, locale) || (course ? holeTitle(course, tee, locale) : '');
      await ops.setShotGeo(shot.id, tee, landing, graphic ? { course, title } : null);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={T.title} description={!tee ? T.hintTee : suggested ? T.hintSuggested : T.hintLanding} wide className="max-w-4xl">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <form
            className="flex min-w-[220px] flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void find();
            }}
          >
            <Input
              className="h-8 text-[13px]"
              placeholder={T.searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={T.search}
            />
            <Button size="sm" variant="secondary" type="submit" aria-label={T.search}>
              <Search />
            </Button>
          </form>
          {satelliteAllowed() ? (
            <Segmented
              label={T.base}
              size="sm"
              value={base}
              onChange={setBase}
              options={[
                { value: 'satellite', label: T.satellite },
                { value: 'osm', label: T.osm },
              ]}
            />
          ) : null}
        </div>
        {results.length ? (
          <ul className="mb-3 max-h-40 overflow-auto rounded-md border border-border text-[13px]">
            {results.map((r) => (
              <li key={`${r.lat},${r.lon}`}>
                <button type="button" className="w-full px-3 py-1.5 text-left hover:bg-surface-sunken" onClick={() => goTo(r)}>
                  {r.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div ref={el} className="h-[440px] w-full overflow-hidden rounded-md border border-border" data-testid="map" />
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
          <span>
            <span className="text-fg-muted">{T.carry}: </span>
            <strong className="tabular text-[15px]">{distTxt}</strong>
          </span>
          {placeTitle(place, locale) || course?.course ? (
            <span className="text-fg-muted">{placeTitle(place, locale) || (tee && course ? holeTitle(course, tee, locale) : course?.course)}</span>
          ) : null}
          {place?.toGreen != null ? <span className="text-fg-muted">{f(T.toGreen, { m: Math.round(place.toGreen) })}</span> : null}
          {!mediaGeo && !shot.geo ? <span className="text-fg-muted">{T.noGps}</span> : null}
          <label className="ml-auto flex items-center gap-2">
            <Switch checked={graphic} onChange={setGraphic} label={T.graphic} />
            {hasGraphic ? T.graphicUpdate : T.graphic}
          </label>
        </div>
        <DialogFooter>
          {tee ? (
            <Button
              variant="ghost"
              onClick={() => {
                setTee(null);
                setLanding(null);
              }}
            >
              {T.reset}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => void apply()} disabled={!tee || !landing} loading={busy}>
            <MapIcon />
            {T.apply}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;
