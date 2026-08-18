import { describe, expect, it } from 'vitest';
import type { LonLatEle } from '../../src/lib/geo';
import { buildGpx, type GpxWaypoint, mergeTracks, parseGpx } from '../../src/lib/gpx';

const COORDS: LonLatEle[] = [
  [6.5, 44.6, 1000],
  [6.51, 44.6, 1100],
];

const WAYPOINTS: GpxWaypoint[] = [
  { lon: 6.505, lat: 44.6, name: 'Source', kind: 'water', sym: 'Drinking Water' },
  { lon: 6.51, lat: 44.6, name: 'Col', kind: 'summit', sym: 'Summit' },
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

  it('carries the hiking activity, waypoint elevations and kinds', () => {
    const doc = new DOMParser().parseFromString(buildGpx('Tour', COORDS, WAYPOINTS), 'application/xml');
    expect(doc.querySelector('trk > type')?.textContent).toBe('hiking');
    // 'Col' sits on the track and borrows its elevation; 'Source' is ~400 m off, too far
    expect(doc.querySelectorAll('wpt > ele')).toHaveLength(1);
    expect([...doc.querySelectorAll('wpt > type')].map(n => n.textContent)).toEqual(['water', 'summit']);
  });

  it('keeps a far-off waypoint honest, with no borrowed elevation', () => {
    const doc = new DOMParser().parseFromString(
      buildGpx('Tour', COORDS, [{ lon: 7.5, lat: 45.6, name: 'Loin' }]),
      'application/xml',
    );
    expect(doc.querySelectorAll('wpt > ele')).toHaveLength(0);
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
    const coords = parsed.tracks[0];
    expect(coords).toHaveLength(COORDS.length);
    expect(coords[0][0]).toBeCloseTo(6.5, 6);
    expect(coords[1][2]).toBe(1100);
    expect(parsed.waypoints.map(w => w.kind)).toEqual(['water', 'summit']);
    expect(parsed.waypoints[0].name).toBe('Source');
  });

  it('falls back to the garmin symbol when a foreign file has no type', () => {
    const foreign = `<?xml version="1.0"?><gpx version="1.1">
      <wpt lat="44.6" lon="6.5"><name>Aiga</name><sym>Drinking Water</sym></wpt>
      <trk><trkseg><trkpt lat="44.6" lon="6.5"><ele>1000</ele></trkpt><trkpt lat="44.61" lon="6.5"><ele>1010</ele></trkpt></trkseg></trk>
    </gpx>`;
    expect(parseGpx(foreign).waypoints[0].kind).toBe('water');
  });

  it('reads route points as well as track points', () => {
    const rte = `<?xml version="1.0"?><gpx version="1.1"><rte>
      <rtept lat="44.6" lon="6.5"><ele>1000</ele></rtept>
      <rtept lat="44.61" lon="6.51"><ele>1050</ele></rtept>
    </rte></gpx>`;
    expect(parseGpx(rte).tracks[0]).toHaveLength(2);
  });

  it('defaults missing elevation to zero and names unnamed waypoints', () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1">
      <wpt lat="44.6" lon="6.5"></wpt>
      <trk><trkseg><trkpt lat="44.6" lon="6.5"></trkpt><trkpt lat="44.61" lon="6.51"></trkpt></trkseg></trk>
    </gpx>`;
    const parsed = parseGpx(gpx);
    expect(parsed.tracks[0][0][2]).toBe(0);
    expect(parsed.waypoints[0].name).toBe('Point 1');
    expect(parsed.waypoints[0].kind).toBe('other');
  });

  it('rejects a file whose only track has a single usable point', () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>
      <trkpt lat="44.6" lon="6.5"><ele>1000</ele></trkpt>
      <trkpt lat="oops" lon="6.51"><ele>1010</ele></trkpt>
    </trkseg></trk></gpx>`;
    // one point is a place, not an itinerary, and saying so beats importing nothing in silence
    expect(() => parseGpx(gpx)).toThrow();
  });

  it('keeps every segment and every route of a file apart', () => {
    // a recorded walk with a pause in it, plus a planned route in the same file
    const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Jour 1</name>
      <trkseg><trkpt lat="44.60" lon="6.50"/><trkpt lat="44.61" lon="6.50"/></trkseg>
      <trkseg><trkpt lat="44.62" lon="6.50"/><trkpt lat="44.63" lon="6.50"/></trkseg>
      </trk><rte><rtept lat="44.70" lon="6.50"/><rtept lat="44.71" lon="6.50"/></rte></gpx>`;
    const parsed = parseGpx(gpx);
    expect(parsed.tracks).toHaveLength(3);
    expect(parsed.tracks.map(t => t.length)).toEqual([2, 2, 2]);
    expect(parsed.name).toBe('Jour 1');
  });

  it('reports missing elevations instead of pretending they are sea level', () => {
    // what c:geo exports for a list of caches: a route, no elevation anywhere
    const route = `<?xml version="1.0"?><gpx version="1.1"><metadata><name>c:geo individual route</name></metadata>
      <wpt lat="45.54" lon="1.79"><name>GC16FZT</name></wpt>
      <rte><rtept lat="45.54" lon="1.79"/><rtept lat="45.52" lon="1.75"/></rte></gpx>`;
    const parsed = parseGpx(route);
    expect(parsed.hasElevation).toBe(false);
    expect(parsed.name).toBe('c:geo individual route');
    expect(parsed.waypoints[0].name).toBe('GC16FZT');
    expect(parseGpx(buildGpx('Tour', COORDS, WAYPOINTS)).hasElevation).toBe(true);
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

  it('drops a corrupt point instead of poisoning the projections', () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>
      <trkpt lat="944.6" lon="6.5"/><trkpt lat="44.61" lon="700"/>
      <trkpt lat="44.60" lon="6.50"/><trkpt lat="44.62" lon="6.50"/>
    </trkseg></trk></gpx>`;
    const parsed = parseGpx(gpx);
    expect(parsed.tracks[0]).toHaveLength(2);
    expect(parsed.tracks[0].every(([lon, lat]) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90)).toBe(true);
  });

  it('rejects a file that is not XML at all', () => {
    expect(() => parseGpx('not a gpx file')).toThrow();
  });
});

describe('mergeTracks', () => {
  const first: LonLatEle[] = [
    [6.5, 44.6, 1000],
    [6.51, 44.6, 1100],
  ];

  it('chains tracks in the order they were picked', () => {
    const second: LonLatEle[] = [
      [6.52, 44.6, 1200],
      [6.53, 44.6, 1300],
    ];
    expect(mergeTracks([first, second]).map(c => c[0])).toEqual([6.5, 6.51, 6.52, 6.53]);
  });

  it('reverses a track exported backwards, so the line keeps going', () => {
    const backwards: LonLatEle[] = [
      [6.53, 44.6, 1300],
      [6.52, 44.6, 1200],
    ];
    expect(mergeTracks([first, backwards]).map(c => c[0])).toEqual([6.5, 6.51, 6.52, 6.53]);
  });

  it('ignores files that carry no track, like a geocache export', () => {
    expect(mergeTracks([[], first, [[6.9, 44.9, 900]]])).toEqual(first);
    expect(mergeTracks([])).toEqual([]);
  });
});
