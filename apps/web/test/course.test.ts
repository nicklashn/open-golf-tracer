import { describe, expect, it } from 'vitest';
import { courseMapGeometry, haversine, holeTitle, placeTitle, simplify, suggestLanding, type CourseData } from '../src/editor/course';

const tee = { lat: 56.2128, lon: 11.737 };

describe('course map geometry', () => {
  it('measures distances like a tape measure', () => {
    // 0.001° of latitude is ~111 m.
    expect(haversine(tee, { lat: tee.lat + 0.001, lon: tee.lon })).toBeCloseTo(111.2, 0);
  });

  it('turns the map so the landing is straight up from the tee', () => {
    const landing = { lat: 56.2133, lon: 11.7385 }; // north-east of the tee
    const g = courseMapGeometry(null, tee, landing);
    expect(g.landing.x).toBe(0);
    expect(g.landing.y).toBeCloseTo(haversine(tee, landing), 0);
  });

  it('keeps closed OSM rings (first point = last point) when simplifying', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0];
    expect(simplify(square, 0.5).length).toBeGreaterThanOrEqual(8);
  });

  it('keeps features around the shot and names the hole teed off from', () => {
    const ring = (lat: number, lon: number, d = 0.0002): [number, number][] => [
      [lat, lon],
      [lat + d, lon],
      [lat + d, lon + d],
      [lat, lon + d],
      [lat, lon],
    ];
    const data: CourseData = {
      course: 'Testbane',
      features: [
        { k: 'green', ring: ring(56.2137, 11.737) },
        { k: 'bunker', ring: ring(56.25, 11.8) }, // far away: dropped
      ],
      holes: [
        {
          ref: '7',
          par: '4',
          name: '',
          line: [
            [56.2129, 11.7371],
            [56.214, 11.737],
          ],
        },
      ],
    };
    const g = courseMapGeometry(data, tee, { lat: 56.2137, lon: 11.737 });
    expect(g.features.map((f) => f.k)).toEqual(['green']);
    expect(holeTitle(data, tee, 'da')).toBe('Hul 7 · Par 4');
    expect(holeTitle(data, { lat: 56.3, lon: 9.9 }, 'en')).toBe('Testbane');
  });

  it('suggests the landing along the hole, never past the green', () => {
    const line: [number, number][] = [
      [56.2, 11.7],
      [56.203, 11.7], // ~334 m north
    ];
    const place = { course: 'X', hole: '6', par: 4, fromTee: 180, toGreen: 154, line };
    const mid = suggestLanding(place, 100)!;
    expect(haversine({ lat: 56.2, lon: 11.7 }, mid)).toBeCloseTo(280, -1);
    const past = suggestLanding(place, 400)!;
    expect(past.lat).toBeCloseTo(56.203, 6);
    expect(suggestLanding({ ...place, line: [] }, 100)).toBeNull();
    expect(placeTitle(place, 'da')).toBe('Hul 6 · Par 4');
    expect(placeTitle({ ...place, hole: '' }, 'en')).toBe('X');
  });
});
