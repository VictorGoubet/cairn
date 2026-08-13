import { downloadTextFile, escXml as esc } from './exportFormats';
import type { LonLatEle } from './geo';
import { haversineM } from './geo';
import { kindFromGarminSym, type PointKind, parseKind } from './points';

export interface GpxWaypoint {
  lon: number;
  lat: number;
  name: string;
  kind?: PointKind;
  sym?: string;
}

/** a waypoint this close to the track inherits the track's elevation */
const WPT_ELEVATION_MAX_M = 120;

export function buildGpx(name: string, coords: LonLatEle[], waypoints: GpxWaypoint[]): string {
  const wpts = waypoints
    .map(w => {
      // devices show richer waypoint pages when elevation is present; a marker close to the
      // track borrows the track's elevation, a distant one honestly carries none
      const nearest = nearestTrackPoint(coords, w.lon, w.lat);
      const ele = nearest && nearest.distM <= WPT_ELEVATION_MAX_M ? `<ele>${nearest.ele.toFixed(1)}</ele>` : '';
      const sym = w.sym ? `<sym>${esc(w.sym)}</sym>` : '';
      const type = w.kind ? `<type>${esc(w.kind)}</type>` : '';
      return `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">${ele}<name>${esc(w.name)}</name>${sym}${type}</wpt>`;
    })
    .join('\n');
  const trkpts = coords
    .map(
      ([lon, lat, ele]) =>
        `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${ele.toFixed(1)}</ele></trkpt>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="cairn" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>
${wpts}
  <trk>
    <name>${esc(name)}</name>
    <type>hiking</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function parseGpx(text: string): {
  coords: LonLatEle[];
  waypoints: { lon: number; lat: number; name: string; kind: PointKind }[];
} {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('invalid GPX');
  const points = doc.querySelectorAll('trkpt, rtept');
  const coords: LonLatEle[] = [];
  for (const pt of points) {
    const lat = attrNumber(pt, 'lat');
    const lon = attrNumber(pt, 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    coords.push([lon, lat, Number(pt.querySelector('ele')?.textContent ?? 0) || 0]);
  }
  const waypoints = [...doc.querySelectorAll('wpt')]
    .map((w, i) => ({
      lon: attrNumber(w, 'lon'),
      lat: attrNumber(w, 'lat'),
      name: w.querySelector('name')?.textContent ?? `Point ${i + 1}`,
      // our own <type> wins on a round-trip, the Garmin symbol covers foreign files
      kind: waypointKind(w),
    }))
    .filter(w => Number.isFinite(w.lon) && Number.isFinite(w.lat));
  return { coords, waypoints };
}

export function downloadGpx(name: string, coords: LonLatEle[], waypoints: GpxWaypoint[]): void {
  downloadTextFile(`${name}.gpx`, 'application/gpx+xml', buildGpx(name, coords, waypoints));
}

function waypointKind(wpt: Element): PointKind {
  const type = wpt.querySelector('type')?.textContent?.trim();
  if (type) return parseKind(type);
  return kindFromGarminSym(wpt.querySelector('sym')?.textContent ?? undefined);
}

function nearestTrackPoint(coords: LonLatEle[], lon: number, lat: number): { ele: number; distM: number } | null {
  let best: { ele: number; distM: number } | null = null;
  for (const c of coords) {
    const distM = haversineM([lon, lat], [c[0], c[1]]);
    if (!best || distM < best.distM) best = { ele: c[2], distM };
  }
  return best;
}

/** a missing or blank attribute is not a zero, which is what Number('') would give */
function attrNumber(el: Element, name: string): number {
  const raw = el.getAttribute(name);
  return raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
}
