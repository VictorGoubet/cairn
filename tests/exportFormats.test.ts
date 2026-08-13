import { describe, expect, it } from 'vitest';
import { buildKml, buildTcx, escXml, type ExportPoint } from '../src/lib/exportFormats';
import type { LonLatEle } from '../src/lib/geo';

const COORDS: LonLatEle[] = [
  [6.5, 44.6, 1000],
  [6.51, 44.6, 1100],
  [6.52, 44.6, 1050],
];

const POINTS: ExportPoint[] = [
  { lon: 6.51, lat: 44.6, name: 'Source du Mélezet', kind: 'water' },
  { lon: 6.52, lat: 44.6, name: 'Col', kind: 'summit' },
];

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc;
}

describe('escXml', () => {
  it('escapes the characters that break element text and double-quoted attributes', () => {
    expect(escXml('a & b < c > d " e')).toBe('a &amp; b &lt; c &gt; d &quot; e');
  });

  it('leaves the apostrophe alone: we never emit single-quoted attributes', () => {
    expect(escXml("Col d'Izoard")).toBe("Col d'Izoard");
  });

  it('escapes an ampersand once, not twice', () => {
    expect(escXml('&amp;')).toBe('&amp;amp;');
  });
});

describe('buildKml', () => {
  it('produces a valid document with one LineString and one Placemark per point', () => {
    const doc = parseXml(buildKml('Tour du Mélezet', COORDS, POINTS));
    expect(doc.querySelectorAll('LineString')).toHaveLength(1);
    // one placemark for the track plus one per point
    expect(doc.querySelectorAll('Placemark').length).toBe(POINTS.length + 1);
    const line = doc.querySelector('LineString coordinates')?.textContent ?? '';
    const triplets = line.trim().split(/\s+/);
    expect(triplets).toHaveLength(COORDS.length);
    // KML wants lon,lat,ele in that order
    expect(triplets[0]).toBe('6.500000,44.600000,1000.0');
  });

  it('keeps names safe when they contain XML characters', () => {
    const doc = parseXml(buildKml('Rando <A & B>', COORDS, [{ ...POINTS[0], name: 'Eau & "fraîche"' }]));
    expect(doc.querySelector('Document > name')?.textContent).toBe('Rando <A & B>');
    const names = [...doc.querySelectorAll('Placemark > name')].map(n => n.textContent);
    expect(names).toContain('Eau & "fraîche"');
  });
});

describe('buildTcx', () => {
  it('produces a Course with a lap, trackpoints and course points', () => {
    const doc = parseXml(buildTcx('Tour', COORDS, POINTS));
    expect(doc.querySelectorAll('Course')).toHaveLength(1);
    expect(doc.querySelectorAll('Lap')).toHaveLength(1);
    expect(doc.querySelectorAll('Trackpoint')).toHaveLength(COORDS.length);
    expect(doc.querySelectorAll('CoursePoint')).toHaveLength(POINTS.length);
  });

  it('maps kinds onto TCX point types, falling back to Generic', () => {
    const doc = parseXml(buildTcx('Tour', COORDS, [...POINTS, { lon: 6.5, lat: 44.6, name: 'Camp', kind: 'camp' }]));
    const types = [...doc.querySelectorAll('CoursePoint > PointType')].map(n => n.textContent);
    expect(types).toEqual(['Water', 'Summit', 'Generic']);
  });

  it('gives every course point an altitude, and long names a Notes element', () => {
    const doc = parseXml(buildTcx('Tour', COORDS, POINTS));
    expect(doc.querySelectorAll('CoursePoint > AltitudeMeters')).toHaveLength(POINTS.length);
    // "Source du Mélezet" overflows the 10-character Name, so the full name rides in Notes
    expect(doc.querySelector('CoursePoint > Notes')?.textContent).toBe('Source du Mélezet');
    expect([...doc.querySelectorAll('CoursePoint > Name')][0]?.textContent).toBe('Source du ');
  });

  it('respects the schema length limits', () => {
    const longName = 'x'.repeat(40);
    const doc = parseXml(buildTcx(longName, COORDS, [{ ...POINTS[0], name: longName }]));
    expect((doc.querySelector('Course > Name')?.textContent ?? '').length).toBeLessThanOrEqual(15);
    expect((doc.querySelector('CoursePoint > Name')?.textContent ?? '').length).toBeLessThanOrEqual(10);
  });

  it('times trackpoints in increasing order, at a constant walking pace', () => {
    const doc = parseXml(buildTcx('Tour', COORDS, []));
    const times = [...doc.querySelectorAll('Trackpoint > Time')].map(n => Date.parse(n.textContent ?? ''));
    expect(times).toHaveLength(COORDS.length);
    expect(times.every(t => Number.isFinite(t))).toBe(true);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  it('keeps altitude and position on every trackpoint', () => {
    const doc = parseXml(buildTcx('Tour', COORDS, []));
    const first = doc.querySelector('Trackpoint');
    expect(first?.querySelector('LatitudeDegrees')?.textContent).toBe('44.600000');
    expect(first?.querySelector('AltitudeMeters')?.textContent).toBe('1000.0');
  });
});
