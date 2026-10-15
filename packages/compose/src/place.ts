import type { Place } from '@golf/schema';

/** "Hul 6 · Par 4" from a media's place, or the course name, or ''. */
export function placeTitle(place: Place | null | undefined, locale: 'da' | 'en'): string {
  if (!place) return '';
  if (!place.hole) return place.course;
  const hole = locale === 'da' ? 'Hul' : 'Hole';
  return place.par ? `${hole} ${place.hole} · Par ${place.par}` : `${hole} ${place.hole}`;
}
