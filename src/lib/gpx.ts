import { downloadTextFile, escXml as esc } from './exportFormats';
import type { LonLatEle } from './geo';
import { elevationStats, formatDistance, haversineM, pathDistanceM } from './geo';
import { kindFromGarminSym, type PointKind, parseKind } from './points';

/** one <trk> of the file: a day of a trek, a course of a project, a route on its own */
export interface GpxTrack {
  name: string;
  coords: LonLatEle[];
  /** shown on the device's track page: what this day or course is, in one line */
  desc?: string;
}

export interface GpxWaypoint {
  lon: number;
  lat: number;
  name: string;
  kind?: PointKind;
  sym?: string;
  /** the kind in the reader's language, for the device's own waypoint page */
  desc?: string;
}

/** a waypoint this close to the track inherits the track's elevation */
const WPT_ELEVATION_MAX_M = 120;

/**
 * Garmin's own GPX extensions (GpxExtensions v3), whose element order the schema fixes.
 *
 * Three of them earn their place for a planned walk. `DisplayMode` puts the waypoint's *name* on
 * the device map beside its pictogram instead of leaving a row of anonymous icons. `Proximity`
 * asks the device to speak up as you come within reach of the things you would regret walking
 * past, so it is set on water, huts and camps and on nothing else. `DisplayColor` gives each track
 * its own colour, which is what tells four courses of one project, or five days of one trek, apart
 * on a small screen.
 */
const GPXX_NS = 'http://www.garmin.com/xmlschemas/GpxExtensions/v3';
/** the kinds worth a nudge when they come within reach, and how far that reach is */
const PROXIMITY_KINDS: PointKind[] = ['water', 'hut', 'camp'];
const PROXIMITY_M = 200;
/** Garmin's named colours, in the order tracks take them */
const TRACK_COLORS = ['Red', 'Blue', 'DarkGreen', 'Magenta', 'DarkYellow', 'Cyan'];

/**
 * GPX 1.1 document for the route.
 *
 * Args:
 *   name: route name, written in the metadata and on the track.
 *   coords: full geometry with elevations.
 *   waypoints: markers to embed.
 *   tracks: optional splits; each becomes its own named `<trk>`, named by the caller, which
 *     watches and other planners read natively, so a trek arrives already split into days.
 */
export function buildGpx(name: string, coords: LonLatEle[], waypoints: GpxWaypoint[], tracks: GpxTrack[] = []): string {
  const wpts = waypoints.map(w => waypoint(w, coords)).join('\n');
  // one <trk> per given track, named by the caller: days of a trek, courses of a project, or the
  // route itself when nothing is split
  const written =
    tracks.length > 0 ? tracks.map((t, i) => track(t, i)) : [track({ name, coords, desc: summary(coords) }, 0)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="cairn" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxx="${GPXX_NS}">
  <metadata>
    <name>${esc(name)}</name>
    <desc>${esc(summary(coords))}</desc>
    <author><name>cairn</name><link href="https://cairn-swart-gamma.vercel.app"><text>cairn</text></link></author>
    <time>${new Date().toISOString()}</time>
    ${bounds(coords)}
  </metadata>
${wpts}
${written.join('\n')}
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

export function downloadGpx(
  name: string,
  coords: LonLatEle[],
  waypoints: GpxWaypoint[],
  tracks: GpxTrack[] = [],
): void {
  downloadTextFile(`${name}.gpx`, 'application/gpx+xml', buildGpx(name, coords, waypoints, tracks));
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

/**
 * One `<trk>`, in the element order GPX 1.1 fixes: name, desc, number, type, extensions, trkseg.
 *
 * No `<time>` on the points, deliberately: timestamps turn a plan into a recording, and an
 * importer that sees them files the file as a past activity rather than as a course to follow.
 */
function track(t: GpxTrack, index: number): string {
  const trkpts = t.coords
    .map(
      ([lon, lat, ele]) =>
        `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${ele.toFixed(1)}</ele></trkpt>`,
    )
    .join('\n');
  const desc = t.desc ? `\n    <desc>${esc(t.desc)}</desc>` : '';
  const colour = TRACK_COLORS[index % TRACK_COLORS.length];
  return `  <trk>
    <name>${esc(t.name)}</name>${desc}
    <number>${index + 1}</number>
    <type>hiking</type>
    <extensions><gpxx:TrackExtension><gpxx:DisplayColor>${colour}</gpxx:DisplayColor></gpxx:TrackExtension></extensions>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>`;
}

/**
 * One `<wpt>`: what it is, what it looks like on the map, and whether to speak up nearby.
 *
 * GPX 1.1 fixes this order too (ele, name, desc, sym, type, extensions), and a device that finds
 * them out of order rejects the file rather than the element.
 */
function waypoint(w: GpxWaypoint, coords: LonLatEle[]): string {
  // devices show richer waypoint pages when elevation is present; a marker close to the track
  // borrows the track's elevation, a distant one honestly carries none
  const nearest = nearestTrackPoint(coords, w.lon, w.lat);
  const ele = nearest && nearest.distM <= WPT_ELEVATION_MAX_M ? `<ele>${nearest.ele.toFixed(1)}</ele>` : '';
  const desc = w.desc ? `<desc>${esc(w.desc)}</desc>` : '';
  const sym = w.sym ? `<sym>${esc(w.sym)}</sym>` : '';
  const type = w.kind ? `<type>${esc(w.kind)}</type>` : '';
  const proximity = w.kind && PROXIMITY_KINDS.includes(w.kind) ? `<gpxx:Proximity>${PROXIMITY_M}</gpxx:Proximity>` : '';
  const extensions =
    `<extensions><gpxx:WaypointExtension>${proximity}` +
    `<gpxx:DisplayMode>SymbolAndName</gpxx:DisplayMode></gpxx:WaypointExtension></extensions>`;
  return `  <wpt lat="${w.lat.toFixed(6)}" lon="${w.lon.toFixed(6)}">${ele}<name>${esc(w.name)}</name>${desc}${sym}${type}${extensions}</wpt>`;
}

/** distance and climb in one line, for the pages that show a description */
function summary(coords: LonLatEle[]): string {
  const { gainM, lossM } = elevationStats(coords);
  const drop = lossM >= 1 ? ` · -${Math.round(lossM)} m` : '';
  return `${formatDistance(pathDistanceM(coords))} · +${Math.round(gainM)} m${drop}`;
}

/** the box the geometry fits in, which importers use to frame it without reading every point */
function bounds(coords: LonLatEle[]): string {
  if (coords.length === 0) return '';
  const lons = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  return (
    `<bounds minlat="${Math.min(...lats).toFixed(6)}" minlon="${Math.min(...lons).toFixed(6)}" ` +
    `maxlat="${Math.max(...lats).toFixed(6)}" maxlon="${Math.max(...lons).toFixed(6)}"/>`
  );
}

function attrNumber(el: Element, name: string): number {
  const raw = el.getAttribute(name);
  return raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
}
