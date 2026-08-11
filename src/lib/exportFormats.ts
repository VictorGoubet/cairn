/**
 * Exports KML (Google Earth / Maps) et TCX (parcours Garmin) construits depuis la trace.
 *
 * Le TCX exige un horodatage par point: les temps sont synthétisés à une allure de marche
 * constante, ce que les appareils acceptent pour un parcours planifié.
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
// types CoursePoint du schéma TCX; les autres genres de points tombent sur "Generic"
const TCX_POINT_TYPES: Partial<Record<PointKind, string>> = {
  eau: 'Water',
  sommet: 'Summit',
  pause: 'Food',
};

/**
 * Document KML: la trace en LineString et chaque point en Placemark.
 *
 * Args:
 *   name: nom de l'itinéraire.
 *   coords: trace complète (lon, lat, altitude).
 *   points: points du parcours et repères hors tracé.
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
 * Parcours TCX: trace horodatée + CoursePoints pour les POI situés sur le tracé.
 *
 * Args:
 *   name: nom de l'itinéraire.
 *   coords: trace complète (lon, lat, altitude).
 *   pois: POI du parcours (les repères hors tracé n'ont pas leur place dans un parcours).
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
      return `      <CoursePoint>
        <Name>${escXml(p.name.slice(0, 10))}</Name>
        <Time>${timeAt(i)}</Time>
        <Position><LatitudeDegrees>${p.lat.toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${p.lon.toFixed(6)}</LongitudeDegrees></Position>
        <PointType>${TCX_POINT_TYPES[p.kind] ?? 'Generic'}</PointType>
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
 * Déclenche le téléchargement d'un fichier texte.
 *
 * Args:
 *   filename: nom complet, extension incluse.
 *   mime: type MIME du contenu.
 *   content: contenu du fichier.
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
