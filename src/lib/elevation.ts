import type { LonLat, LonLatEle } from './geo';
import { fetchWithTimeout } from './http';

const ALTI_URL = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevationLine.json';

export async function elevationLine(from: LonLat, to: LonLat, sampling: number): Promise<LonLatEle[]> {
  const url = `${ALTI_URL}?lon=${from[0]}|${to[0]}&lat=${from[1]}|${to[1]}&resource=ign_rge_alti_wld&sampling=${sampling}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`altimetrie ${res.status}`);
  const data = await res.json();
  // extreme negative z means outside the DEM coverage
  return data.elevations.map((e: { lon: number; lat: number; z: number }) => [e.lon, e.lat, e.z > -100 ? e.z : 0]);
}
