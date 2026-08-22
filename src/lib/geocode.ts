import { departementFromPostcode } from './departements';
import { fetchWithTimeout } from './http';
import { tNow } from './i18n';

const GEOCODE_URL = 'https://data.geopf.fr/geocodage/search';
// worldwide fallback (OSM data, no key): the IGN geocoder stops at the French border
const PHOTON_URL = 'https://photon.komoot.io/api/';

// IGN categories too vague to help tell two homonyms apart
const GENERIC_CATEGORIES = new Set(['administratif', "zone d'activité ou d'intérêt", "zone d'habitation"]);

const ADDRESS_TYPES: Record<string, string> = {
  municipality: 'commune',
  locality: 'lieu-dit',
  street: 'rue',
  housenumber: 'adresse',
};

export interface GeocodeResult {
  name: string;
  detail: string;
  lon: number;
  lat: number;
}

interface RawFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    label?: string;
    toponym?: string;
    name?: string | string[];
    city?: string | string[];
    postcode?: string | string[];
    category?: string[];
    type?: string;
  };
}

export async function searchPlaces(query: string): Promise<GeocodeResult[]> {
  const fromIgn = await searchIgn(query).catch(() => [] as GeocodeResult[]);
  // a thin French answer means the place probably lives beyond the border: ask the world
  if (fromIgn.length >= 3) return fromIgn;
  const fromPhoton = await searchPhoton(query).catch(() => [] as GeocodeResult[]);
  const seen = new Set(fromIgn.map(r => `${r.lon.toFixed(3)},${r.lat.toFixed(3)}`));
  return [...fromIgn, ...fromPhoton.filter(r => !seen.has(`${r.lon.toFixed(3)},${r.lat.toFixed(3)}`))].slice(0, 6);
}

async function searchIgn(query: string): Promise<GeocodeResult[]> {
  const url = `${GEOCODE_URL}?q=${encodeURIComponent(query)}&limit=10&index=poi,address`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`geocodage ${res.status}`);
  const data = await res.json();

  const results: GeocodeResult[] = [];
  const seen = new Set<string>();
  for (const feature of data.features as RawFeature[]) {
    const p = feature.properties;
    const name = first(p.name) ?? p.toponym ?? p.label ?? tNow('unknown_place');
    const postcode = first(p.postcode) ?? '';
    const key = `${name}|${postcode}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const category =
      p.category?.find(c => !GENERIC_CATEGORIES.has(c)) ?? p.category?.[0] ?? ADDRESS_TYPES[p.type ?? ''];
    const city = first(p.city);
    const place = [postcode, city !== name ? city : ''].filter(Boolean).join(' ');
    const departement = departementFromPostcode(postcode);
    results.push({
      name,
      detail: [category, place, departement ? `${departement.name} · ${departement.region}` : '']
        .filter(Boolean)
        .join(' · '),
      lon: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1],
    });
  }
  return results.slice(0, 6);
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: { name?: string; city?: string; state?: string; country?: string; osm_value?: string };
}

async function searchPhoton(query: string): Promise<GeocodeResult[]> {
  const res = await fetchWithTimeout(`${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=6&lang=fr`);
  if (!res.ok) throw new Error(`photon ${res.status}`);
  const data = await res.json();
  return (data.features as PhotonFeature[]).flatMap(feature => {
    const p = feature.properties;
    if (!p.name) return [];
    return [
      {
        name: p.name,
        detail: [p.osm_value?.replaceAll('_', ' '), p.city, p.state, p.country].filter(Boolean).join(' · '),
        lon: feature.geometry.coordinates[0],
        lat: feature.geometry.coordinates[1],
      },
    ];
  });
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
