/**
 * The shot list as the golfer thinks of it: by hole ("Hole 4 · par 4 · 5 shots"), numbered within
 * the hole, in playing order. Only shown shots are numbered, so hiding one leaves no gap. A project
 * whose clips have no hole (a range session, a single clip) keeps one flat, numbered list.
 */
import type { Project, Shot } from '@golf/schema';
import type { Dict } from '@/lib/i18n';

export interface ShotGroup {
  /** The hole ('7'), or '' for shots on no known hole. */
  hole: string;
  par: number | null;
  shots: Shot[];
}

export interface ShotList {
  /** True when at least one shown shot is on a known hole. */
  byHole: boolean;
  /** Shown shots: one group per hole in playing order (a single group with hole '' when flat). */
  groups: ShotGroup[];
  /** Hidden shots (short game, doubtful candidates), in playing order, not numbered. */
  hidden: Shot[];
  /** Number of each shown shot: within its hole, or in the whole list when flat. */
  numbers: Map<string, number>;
}

export function shotList(doc: Pick<Project, 'shots' | 'media'> & Partial<Pick<Project, 'scoreEdits'>>): ShotList {
  const visible = doc.shots.filter((s) => s.visible);
  const holeOf = (s: Shot) => doc.media[s.mediaId]?.place?.hole ?? '';
  const byHole = visible.some((s) => holeOf(s) !== '');
  const groups: ShotGroup[] = [];
  const numbers = new Map<string, number>();
  if (!byHole) {
    if (visible.length) groups.push({ hole: '', par: null, shots: visible });
    visible.forEach((s, i) => numbers.set(s.id, i + 1));
  } else {
    // A hole played, left and come back to (clips out of order) stays one group.
    const index = new Map<string, ShotGroup>();
    for (const s of visible) {
      const hole = holeOf(s);
      let g = index.get(hole);
      if (!g) {
        const par = doc.scoreEdits?.[hole]?.par ?? doc.media[s.mediaId]?.place?.par ?? null;
        g = { hole, par: hole ? par : null, shots: [] };
        index.set(hole, g);
        groups.push(g);
      }
      g.shots.push(s);
      numbers.set(s.id, g.shots.length);
    }
  }
  return { byHole, groups, hidden: doc.shots.filter((s) => !s.visible), numbers };
}

/** "Shot 3" (its number in the list), "Putt", or for a hidden one what it is; the user's name wins. */
export function shotName(shot: Shot, n: number, t: Dict): string {
  if (shot.label) return shot.label;
  if (shot.kind === 'putt') return t.shots.putt;
  if (!n) return shot.kind === 'short' ? t.shots.shortShot : t.shots.candidate;
  return t.shots.shot.replace('{n}', String(n));
}
