/**
 * Geography for "measure on the map": distances, local metres and the course-map layer data
 * (tee at the origin, landing straight up, polygons simplified to keep the project small).
 */
import { haversine } from '@golf/compose';
import type { CourseFeatureKind, CourseMapProps, GeoPoint, Place } from '@golf/schema';

export { haversine, placeTitle } from '@golf/compose';

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export interface CourseData {
  course: string;
  features: { k: CourseFeatureKind; ring: [number, number][] }[];
  holes: { ref: string; par: string; name: string; line: [number, number][] }[];
}

/** East/north metres of p relative to origin (equirectangular; exact enough within a few km). */
export function toLocal(origin: Pick<GeoPoint, 'lat' | 'lon'>, lat: number, lon: number): [number, number] {
  return [rad(lon - origin.lon) * R * Math.cos(rad(origin.lat)), rad(lat - origin.lat) * R];
}

/** Douglas–Peucker on a flat [x, y, …] ring. OSM rings are closed (first = last point), which
 *  would give a zero-length base line, so the ring is split at the point farthest from the start. */
export function simplify(pts: number[], tol: number): number[] {
  const n = pts.length / 2;
  if (n <= 3) return pts;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[2 * i] - pts[0], pts[2 * i + 1] - pts[1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  if (far === 0 || far === n - 1) return simplifyOpen(pts, tol);
  const a = simplifyOpen(pts.slice(0, 2 * far + 2), tol);
  const b = simplifyOpen(pts.slice(2 * far), tol);
  return [...a, ...b.slice(2)];
}

function simplifyOpen(pts: number[], tol: number): number[] {
  const n = pts.length / 2;
  if (n <= 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[2 * a];
    const ay = pts[2 * a + 1];
    const dx = pts[2 * b] - ax;
    const dy = pts[2 * b + 1] - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[2 * i] - ax) * dy - (pts[2 * i + 1] - ay) * dx) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

/** The hole whose tee end is nearest to the tee (within 120 m): "Hul 7 · Par 4". */
export function holeTitle(data: CourseData, tee: GeoPoint, locale: 'da' | 'en'): string {
  let best: { d: number; ref: string; par: string } | null = null;
  for (const h of data.holes) {
    if (!h.ref || !h.line.length) continue;
    const [lat, lon] = h.line[0];
    const d = haversine(tee, { lat, lon });
    if (d < 120 && (!best || d < best.d)) best = { d, ref: h.ref, par: h.par };
  }
  if (!best) return data.course;
  const hole = locale === 'da' ? 'Hul' : 'Hole';
  return best.par ? `${hole} ${best.ref} · Par ${best.par}` : `${hole} ${best.ref}`;
}

/** Layer geometry: course polygons around the shot in metres, rotated so the landing is +y. */
export function courseMapGeometry(data: CourseData | null, tee: GeoPoint, landing: GeoPoint): Pick<CourseMapProps, 'features' | 'landing'> {
  const [le, ln] = toLocal(tee, landing.lat, landing.lon);
  const L = Math.max(1, Math.hypot(le, ln));
  const a = Math.atan2(le, ln); // bearing of the shot (0 = north)
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const rot = (e: number, n: number): [number, number] => [e * ca - n * sa, e * sa + n * ca];
  // Window the card shows (with margin): the shot fills ~80 % of the height.
  const halfW = Math.max(0.6 * L, 120);
  const yMin = -0.35 * L - 60;
  const yMax = 1.4 * L + 60;
  const features: CourseMapProps['features'] = [];
  for (const f of data?.features ?? []) {
    const flat: number[] = [];
    let inside = false;
    for (const [lat, lon] of f.ring) {
      const [x, y] = rot(...toLocal(tee, lat, lon));
      flat.push(x, y);
      if (Math.abs(x) <= halfW && y >= yMin && y <= yMax) inside = true;
    }
    if (!inside) continue;
    let p = simplify(flat, 0.8);
    for (let tol = 2; p.length > 4000; tol *= 2) p = simplify(flat, tol);
    if (p.length < 6) continue;
    features.push({ k: f.k, p: p.map((v) => Math.round(v * 10) / 10) });
    if (features.length >= 400) break;
  }
  return { features, landing: { x: 0, y: Math.round(L * 10) / 10 } };
}

/** The point `metres` along a [lat, lon] polyline (clamped to its ends). */
export function pointAlong(line: readonly (readonly [number, number])[], metres: number): GeoPoint | null {
  if (line.length < 2) return line.length ? { lat: line[0][0], lon: line[0][1] } : null;
  let left = Math.max(0, metres);
  for (let i = 1; i < line.length; i++) {
    const a = { lat: line[i - 1][0], lon: line[i - 1][1] };
    const b = { lat: line[i][0], lon: line[i][1] };
    const seg = haversine(a, b);
    if (left <= seg || i === line.length - 1) {
      const f = seg > 0 ? Math.min(1, left / seg) : 0;
      return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    }
    left -= seg;
  }
  return null;
}

/**
 * Where the ball probably landed: from the player's spot on the hole, the estimated carry
 * further along the hole's centre line – but not beyond the green (the line's end).
 */
export function suggestLanding(place: Place | null | undefined, carryM: number | null | undefined): GeoPoint | null {
  if (!place?.line?.length || place.fromTee == null || !carryM) return null;
  const p = pointAlong(place.line, place.fromTee + carryM);
  return p ? { lat: Math.round(p.lat * 1e6) / 1e6, lon: Math.round(p.lon * 1e6) / 1e6 } : null;
}

/** "16. jun." – the day the earliest clip was filmed (from the file), or '' if unknown. */
export function filmedDay(media: Record<string, { recordedAt?: string | null }>, locale: 'da' | 'en'): string {
  const days = Object.values(media)
    .map((m) => (m.recordedAt ? new Date(m.recordedAt.replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) : null))
    .filter((d): d is Date => !!d && !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  return days.length ? days[0].toLocaleDateString(locale === 'da' ? 'da-DK' : 'en-GB', { day: 'numeric', month: 'short' }) : '';
}
