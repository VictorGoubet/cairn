import { downloadTextFile, escXml as esc } from './exportFormats';
import type { LonLatEle } from './geo';
import { kindFromGarminSym, type PointKind } from './points';

export interface GpxWaypoint {
  lon: number;
  lat: number;
  name: string;
  sym?: string;
}

export function buildGpx(name: string, coords: LonLatEle[], waypoints: GpxWaypoint[]): string {
  const wpts = waypoints
    .map(w => {
      const sym = w.sym ? `<sym>${esc(w.sym)}</sym>` : '';
      return `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}"><name>${esc(w.name)}</name>${sym}</wpt>`;
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
  <metadata><name>${esc(name)}</name></metadata>
${wpts}
  <trk>
    <name>${esc(name)}</name>
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
      kind: kindFromGarminSym(w.querySelector('sym')?.textContent ?? undefined),
    }))
    .filter(w => Number.isFinite(w.lon) && Number.isFinite(w.lat));
  return { coords, waypoints };
}

export function downloadGpx(name: string, coords: LonLatEle[], waypoints: GpxWaypoint[]): void {
  downloadTextFile(`${name}.gpx`, 'application/gpx+xml', buildGpx(name, coords, waypoints));
}

/** a missing or blank attribute is not a zero, which is what Number('') would give */
function attrNumber(el: Element, name: string): number {
  const raw = el.getAttribute(name);
  return raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
}
