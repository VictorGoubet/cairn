/**
 * KML (Google Earth / Maps) and TCX (Garmin route) exports built from the track.
 *
 * TCX requires a timestamp per point: times are synthesized at a constant walking pace, which
 * devices accept for a planned route.
 */

import { cumulativeDistancesM, type LonLatEle } from './geo';
import type { PointKind } from './points';

export interface ExportPoint {
  lon: number;
  lat: number;
  name: string;
  kind: PointKind;
}

const WALKING_SPEED_M_S = 4000 / 3600;
// CoursePoint types of the TCX schema; the vocabulary is cycling-flavored, so the mapping
// borrows the closest alert a watch can raise, and other kinds fall back to "Generic"
const TCX_POINT_TYPES: Partial<Record<PointKind, string>> = {
  water: 'Water',
  summit: 'Summit',
  break: 'Food',
  camp: 'Generic',
  hut: 'FirstAid',
  viewpoint: 'Generic',
};

/**
 * KML document: the track as a LineString and each point as a Placemark.
 *
 * Args:
 *   name: route name.
 *   coords: full track (lon, lat, elevation).
 *   points: route points and off-track markers.
 */
export function buildKml(name: string, coords: LonLatEle[], points: ExportPoint[]): string {
  const placemarks = points
    .map(
      p => `    <Placemark>
      <name>${escXml(p.name)}</name>
      <Point><coordinates>${p.lon.toFixed(6)},${p.lat.toFixed(6)}</coordinates></Point>
    </Placemark>`,
    )
    .join('\n');
  const line = coords.map(([lon, lat, ele]) => `${lon.toFixed(6)},${lat.toFixed(6)},${ele.toFixed(1)}`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escXml(name)}</name>
${placemarks}
    <Placemark>
      <name>${escXml(name)}</name>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>${line}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
`;
}

/**
 * TCX course: timestamped track plus CoursePoints for the POIs lying on the track.
 *
 * Args:
 *   name: route name.
 *   coords: full track (lon, lat, elevation).
 *   pois: route POIs (off-track markers have no place in a route).
 */
export function buildTcx(name: string, coords: LonLatEle[], pois: ExportPoint[]): string {
  const start = Date.now();
  const distances = cumulativeDistancesM(coords);
  const timeAt = (i: number) => new Date(start + (distances[i] / WALKING_SPEED_M_S) * 1000).toISOString();
  const trackpoints = coords
    .map(
      ([lon, lat, ele], i) => `        <Trackpoint>
          <Time>${timeAt(i)}</Time>
          <Position><LatitudeDegrees>${lat.toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${lon.toFixed(6)}</LongitudeDegrees></Position>
          <AltitudeMeters>${ele.toFixed(1)}</AltitudeMeters>
          <DistanceMeters>${distances[i].toFixed(1)}</DistanceMeters>
        </Trackpoint>`,
    )
    .join('\n');
  const coursePoints = pois
    .map(p => {
      const i = nearestCoordIndex(coords, p.lon, p.lat);
      // the watch shows Name (10 chars max on most devices) in the alert and Notes on the
      // point's page; altitude feeds the ascent-to-next-point screens
      const notes = p.name.length > 10 ? `\n        <Notes>${escXml(p.name)}</Notes>` : '';
      return `      <CoursePoint>
        <Name>${escXml(p.name.slice(0, 10))}</Name>
        <Time>${timeAt(i)}</Time>
        <Position><LatitudeDegrees>${p.lat.toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${p.lon.toFixed(6)}</LongitudeDegrees></Position>
        <AltitudeMeters>${coords[i][2].toFixed(1)}</AltitudeMeters>
        <PointType>${TCX_POINT_TYPES[p.kind] ?? 'Generic'}</PointType>${notes}
      </CoursePoint>`;
    })
    .join('\n');
  const last = coords.length - 1;
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Courses>
    <Course>
      <Name>${escXml(name.slice(0, 15))}</Name>
      <Lap>
        <TotalTimeSeconds>${(distances[last] / WALKING_SPEED_M_S).toFixed(0)}</TotalTimeSeconds>
        <DistanceMeters>${distances[last].toFixed(1)}</DistanceMeters>
        <BeginPosition><LatitudeDegrees>${coords[0][1].toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${coords[0][0].toFixed(6)}</LongitudeDegrees></BeginPosition>
        <EndPosition><LatitudeDegrees>${coords[last][1].toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${coords[last][0].toFixed(6)}</LongitudeDegrees></EndPosition>
        <Intensity>Active</Intensity>
      </Lap>
      <Track>
${trackpoints}
      </Track>
${coursePoints}
    </Course>
  </Courses>
</TrainingCenterDatabase>
`;
}

/**
 * Triggers the download of a text file.
 *
 * Args:
 *   filename: full name, extension included.
 *   mime: MIME type of the content.
 *   content: file content.
 */
export function downloadTextFile(filename: string, mime: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function escXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function nearestCoordIndex(coords: LonLatEle[], lon: number, lat: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  coords.forEach((c, i) => {
    const d = (c[0] - lon) ** 2 + (c[1] - lat) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}
