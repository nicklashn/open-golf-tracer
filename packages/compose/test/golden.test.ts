import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { highlightShort, layerDefaults, shortFor, youtubeVideo } from '../src';
import { demoProject, roundProject, stable, withStableIds } from './fixtures';

// Recorded from the editor's generators before they moved here (apps/web/src/editor/generate.ts
// and shorts.ts at bc92ba8), with the same deterministic ids: the move must not change a byte.
const golden = JSON.parse(readFileSync(new URL('./fixtures/golden.json', import.meta.url), 'utf8'));
const NAMES = {
  text: 'Text',
  statCard: 'Stats',
  lowerThird: 'Lower third',
  holeInfo: 'Hole',
  courseMap: 'Map',
  textDefault: 'Your text',
  lowerThirdDefault: 'Title',
  lowerThirdSub: 'Subtitle',
  distanceLabel: 'Carry',
};

describe('generators give the same edits as before the move', () => {
  for (const [key, make] of [
    ['demo', demoProject],
    ['round', roundProject],
  ] as const) {
    for (const locale of ['da', 'en'] as const) {
      it(`${key} (${locale})`, () => {
        const doc = make();
        expect(stable(withStableIds(() => youtubeVideo(doc, locale, 'YT', NAMES)))).toEqual(golden[`${key}.youtube.${locale}`]);
        expect(stable(withStableIds(() => highlightShort(doc, locale, 'HL', NAMES)))).toEqual(golden[`${key}.highlight.${locale}`]);
        expect(stable(withStableIds(() => shortFor(doc, doc.shots[0], 'Short', locale)))).toEqual(golden[`${key}.short.${locale}`]);
      });
    }
  }

  it('layer defaults', () => {
    const doc = roundProject();
    for (const type of ['text', 'statCard', 'shape', 'arrow', 'image', 'lowerThird', 'holeInfo', 'distance', 'courseMap'] as const)
      expect(stable(withStableIds(() => layerDefaults(type, NAMES, doc, 3, 'da')))).toEqual(golden[`layer.${type}`]);
  });

  it('layer names do not leak from one call into the next', () => {
    const doc = roundProject();
    const named = withStableIds(() => youtubeVideo(doc, 'da', 'YT', { statCard: 'Tal' }));
    const plain = withStableIds(() => youtubeVideo(doc, 'da', 'YT'));
    expect(named.layers.find((l) => l.type === 'statCard')?.name).toBe('Tal');
    expect(plain.layers.find((l) => l.type === 'statCard')?.name).toBe('statCard');
  });
});
