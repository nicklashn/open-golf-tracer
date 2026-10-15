import type { GeoPoint, Place } from '@golf/schema';

/** "Hul 6 · Par 4" from a media's place, or the course name, or ''. */
export function placeTitle(place: Place | null | undefined, locale: 'da' | 'en'): string {
  if (!place) return '';
  if (!place.hole) return place.course;
  const hole = locale === 'da' ? 'Hul' : 'Hole';
  return place.par ? `${hole} ${place.hole} · Par ${place.par}` : `${hole} ${place.hole}`;
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: Pick<GeoPoint, 'lat' | 'lon'>, b: Pick<GeoPoint, 'lat' | 'lon'>): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
