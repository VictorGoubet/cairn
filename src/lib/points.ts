import type { MsgKey } from './i18n';

export type PointKind =
  | 'checkpoint'
  | 'water'
  | 'viewpoint'
  | 'break'
  | 'camp'
  | 'hut'
  | 'summit'
  | 'geocache'
  | 'other';

export interface PointKindDef {
  id: PointKind;
  emoji: string;
  color: string;
  /** <sym> value Garmin watches understand, so the right pictogram shows up on the device */
  garminSym: string | null;
}

export const POINT_KINDS: PointKindDef[] = [
  { id: 'checkpoint', emoji: '•', color: '#e34948', garminSym: null },
  { id: 'water', emoji: '💧', color: '#2a78d6', garminSym: 'Drinking Water' },
  { id: 'viewpoint', emoji: '🌄', color: '#7c4dbe', garminSym: 'Scenic Area' },
  { id: 'break', emoji: '☕', color: '#eda100', garminSym: 'Picnic Area' },
  { id: 'camp', emoji: '⛺', color: '#008300', garminSym: 'Campground' },
  { id: 'hut', emoji: '🛖', color: '#8a5a2b', garminSym: 'Lodging' },
  { id: 'summit', emoji: '⛰️', color: '#52514e', garminSym: 'Summit' },
  // geocaching green, and the sym Garmin devices use for a cache
  { id: 'geocache', emoji: '📦', color: '#02874d', garminSym: 'Geocache' },
  { id: 'other', emoji: '📍', color: '#e87ba4', garminSym: 'Flag, Blue' },
];

/** kinds stored before the codebase switched to english identifiers */
const LEGACY_KINDS: Record<string, PointKind> = {
  eau: 'water',
  vue: 'viewpoint',
  pause: 'break',
  bivouac: 'camp',
  refuge: 'hut',
  sommet: 'summit',
  autre: 'other',
  etape: 'camp',
};

export function kindLabelKey(kind: PointKind): MsgKey {
  return `kind_${kind}` as MsgKey;
}

export function kindDef(kind: PointKind): PointKindDef {
  return POINT_KINDS.find(k => k.id === kind) ?? POINT_KINDS[POINT_KINDS.length - 1];
}

export function kindFromGarminSym(sym: string | undefined): PointKind {
  if (isGeocacheLabel(sym)) return 'geocache';
  return POINT_KINDS.find(k => k.garminSym === sym)?.id ?? 'other';
}

/** accepts a kind coming from storage, a share link or a GPX file, whatever its vintage */
export function parseKind(kind: string | undefined): PointKind {
  if (!kind) return 'other';
  if (POINT_KINDS.some(k => k.id === kind)) return kind as PointKind;
  if (isGeocacheLabel(kind)) return 'geocache';
  return LEGACY_KINDS[kind] ?? 'other';
}

/** c:geo and GSAK write the cache type as `Geocache|Traditional Cache`, or `Geocache Found` as sym */
function isGeocacheLabel(value: string | undefined): boolean {
  return value?.toLowerCase().startsWith('geocache') ?? false;
}
