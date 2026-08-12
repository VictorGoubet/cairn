import { describe, expect, it } from 'vitest';
import type { LonLatEle } from '../src/lib/geo';
import { buildGpx, type GpxWaypoint, parseGpx } from '../src/lib/gpx';

const COORDS: LonLatEle[] = [
  [6.5, 44.6, 1000],
  [6.51, 44.6, 1100],
];

const WAYPOINTS: GpxWaypoint[] = [
  { lon: 6.505, lat: 44.6, name: 'Source', sym: 'Drinking Water' },
  { lon: 6.51, lat: 44.6, name: 'Col', sym: 'Summit' },
];

describe('buildGpx', () => {
  it('writes a valid 1.1 document with the track and its waypoints', () => {
    const doc = new DOMParser().parseFromString(buildGpx('Tour', COORDS, WAYPOINTS), 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.getAttribute('version')).toBe('1.1');
    expect(doc.querySelectorAll('trkpt')).toHaveLength(COORDS.length);
    expect(doc.querySelectorAll('wpt')).toHaveLength(WAYPOINTS.length);
    expect(doc.querySelector('trkpt')?.getAttribute('lat')).toBe('44.600000');
    expect(doc.querySelector('trkpt > ele')?.textContent).toBe('1000.0');
  });

  it('keeps garmin symbols so the watch shows the right pictogram', () => {
    const doc = new DOMParser().parseFromString(buildGpx('Tour', COORDS, WAYPOINTS), 'application/xml');
    expect([...doc.querySelectorAll('wpt > sym')].map(s => s.textContent)).toEqual(['Drinking Water', 'Summit']);
  });

  it('omits the sym element when a point has none', () => {
    const doc = new DOMParser().parseFromString(
      buildGpx('Tour', COORDS, [{ lon: 6.5, lat: 44.6, name: 'Plain' }]),
      'application/xml',
    );
    expect(doc.querySelectorAll('wpt > sym')).toHaveLength(0);
  });

  it('escapes names that would break the document', () => {
    const doc = new DOMParser().parseFromString(
      buildGpx('A & B', COORDS, [{ lon: 6.5, lat: 44.6, name: '<Col> "haut"' }]),
      'application/xml',
    );
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.querySelector('wpt > name')?.textContent).toBe('<Col> "haut"');
  });
});

describe('parseGpx', () => {
  it('round-trips what we export', () => {
    const parsed = parseGpx(buildGpx('Tour', COORDS, WAYPOINTS));
    expect(parsed.coords).toHaveLength(COORDS.length);
    expect(parsed.coords[0][0]).toBeCloseTo(6.5, 6);
    expect(parsed.coords[1][2]).toBe(1100);
    expect(parsed.waypoints.map(w => w.kind)).toEqual(['water', 'summit']);
    expect(parsed.waypoints[0].name).toBe('Source');
  });

  it('reads route points as well as track points', () => {
    const rte = `<?xml version="1.0"?><gpx version="1.1"><rte>
      <rtept lat="44.6" lon="6.5"><ele>1000</ele></rtept>
      <rtept lat="44.61" lon="6.51"><ele>1050</ele></rtept>
    </rte></gpx>`;
    expect(parseGpx(rte).coords).toHaveLength(2);
  });

  it('defaults missing elevation to zero and names unnamed waypoints', () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1">
      <wpt lat="44.6" lon="6.5"></wpt>
      <trk><trkseg><trkpt lat="44.6" lon="6.5"></trkpt><trkpt lat="44.61" lon="6.51"></trkpt></trkseg></trk>
    </gpx>`;
    const parsed = parseGpx(gpx);
    expect(parsed.coords[0][2]).toBe(0);
    expect(parsed.waypoints[0].name).toBe('Point 1');
    expect(parsed.waypoints[0].kind).toBe('other');
  });

  it('skips points without usable coordinates', () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>
      <trkpt lat="44.6" lon="6.5"><ele>1000</ele></trkpt>
      <trkpt lat="oops" lon="6.51"><ele>1010</ele></trkpt>
    </trkseg></trk></gpx>`;
    expect(parseGpx(gpx).coords).toHaveLength(1);
  });

  it('drops waypoints whose coordinates are unusable', () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1">
      <wpt lat="44.6" lon="6.5"><name>Good</name></wpt>
      <wpt lat="" lon="6.5"><name>No lat</name></wpt>
      <wpt lon="6.5"><name>Missing lat</name></wpt>
      <wpt lat="oops" lon="6.5"><name>Not a number</name></wpt>
      <trk><trkseg><trkpt lat="44.6" lon="6.5"></trkpt><trkpt lat="44.61" lon="6.51"></trkpt></trkseg></trk>
    </gpx>`;
    const parsed = parseGpx(gpx);
    expect(parsed.waypoints.map(w => w.name)).toEqual(['Good']);
    expect(parsed.waypoints.every(w => Number.isFinite(w.lon) && Number.isFinite(w.lat))).toBe(true);
  });

  it('rejects a file that is not XML at all', () => {
    expect(() => parseGpx('not a gpx file')).toThrow();
  });
});
