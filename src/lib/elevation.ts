import type { LonLat, LonLatEle } from './geo';

const ALTI_URL = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevationLine.json';

export async function elevationLine(from: LonLat, to: LonLat, sampling: number): Promise<LonLatEle[]> {
  const url = `${ALTI_URL}?lon=${from[0]}|${to[0]}&lat=${from[1]}|${to[1]}&resource=ign_rge_alti_wld&sampling=${sampling}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`altimetrie ${res.status}`);
  const data = await res.json();
  // z négatif extrême = hors couverture du MNT
  return data.elevations.map((e: { lon: number; lat: number; z: number }) => [e.lon, e.lat, e.z > -100 ? e.z : 0]);
}
