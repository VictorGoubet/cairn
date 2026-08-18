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

/**
 * Chains several imported tracks into one, in the order they were given.
 *
 * Each track is appended to the end of the chain, reversed when its far end is the closer one:
 * files exported in whatever direction still merge into a line that goes somewhere instead of
 * zigzagging. Nothing is dropped, so a gap between two tracks stays visible as a long leg the
 * router will bridge.
 *
 * Args:
 *   tracks: track geometries, in the order the user picked the files.
 */
export function mergeTracks(tracks: LonLatEle[][]): LonLatEle[] {
  const usable = tracks.filter(t => t.length >= 2);
  if (usable.length === 0) return [];
  let merged = usable[0];
  for (const track of usable.slice(1)) {
    const end = merged[merged.length - 1];
    const toStart = haversineM([end[0], end[1]], [track[0][0], track[0][1]]);
    const toEnd = haversineM([end[0], end[1]], [track[track.length - 1][0], track[track.length - 1][1]]);
    merged = [...merged, ...(toEnd < toStart ? [...track].reverse() : track)];
  }
  return merged;
}

/**
 * Reads whatever a GPX file happens to carry.
 *
 * The format is a family, and every exporter picks a corner of it: a recorded track in one or
 * several `<trkseg>`, a planned `<rte>` (what c:geo hands out for a list of caches), a bare list
 * of `<wpt>`, with or without elevations. Each track and each route comes back separately so the
 * caller can chain them; the elevations are reported as missing rather than as zero, because a
 * profile flat at sea level is worse than no profile.
 *
 * Args:
 *   text: file contents.
 *
 * Returns:
 *   Every track in document order, the waypoints, the file's name, and whether any elevation
 *   was found.
 *
 * Raises:
 *   Error, when the document is not XML or carries no usable geometry at all.
 */
export function parseGpx(text: string): {
  tracks: LonLatEle[][];
  waypoints: { lon: number; lat: number; name: string; kind: PointKind }[];
  name: string;
  hasElevation: boolean;
} {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('invalid GPX');

  let hasElevation = false;
  const readPoints = (container: Element, selector: string): LonLatEle[] => {
    const points: LonLatEle[] = [];
    for (const pt of [...container.querySelectorAll(selector)]) {
      const lat = attrNumber(pt, 'lat');
      const lon = attrNumber(pt, 'lon');
      if (!onEarth(lon, lat)) continue;
      const raw = pt.querySelector('ele')?.textContent;
      const ele = raw === null || raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
      if (Number.isFinite(ele)) hasElevation = true;
      points.push([lon, lat, Number.isFinite(ele) ? ele : 0]);
    }
    return points;
  };

  // a multi-segment track is one walk with pauses in it, a second <trk> is another walk: both
  // come back as separate tracks and the caller decides how to chain them
  const tracks = [
    ...[...doc.querySelectorAll('trkseg')].map(seg => readPoints(seg, 'trkpt')),
    ...[...doc.querySelectorAll('rte')].map(rte => readPoints(rte, 'rtept')),
  ].filter(track => track.length >= 2);

  const waypoints = [...doc.querySelectorAll('wpt')]
    .map((w, i) => ({
      lon: attrNumber(w, 'lon'),
      lat: attrNumber(w, 'lat'),
      name: w.querySelector('name')?.textContent ?? `Point ${i + 1}`,
      kind: waypointKind(w),
    }))
    .filter(w => onEarth(w.lon, w.lat));

  if (tracks.length === 0 && waypoints.length === 0) throw new Error('GPX carries no geometry');

  const name =
    doc.querySelector('metadata > name')?.textContent?.trim() ||
    doc.querySelector('trk > name, rte > name')?.textContent?.trim() ||
    '';
  return { tracks, waypoints, name, hasElevation };
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
/** a corrupt point (lat 944, lon 700) would poison every projection downstream */
function onEarth(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
}

function attrNumber(el: Element, name: string): number {
  const raw = el.getAttribute(name);
  return raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
}
