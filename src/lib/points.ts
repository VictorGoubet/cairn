import type { MsgKey } from './i18n';

export type PointKind = 'checkpoint' | 'eau' | 'vue' | 'pause' | 'bivouac' | 'refuge' | 'sommet' | 'autre';

export interface PointKindDef {
  id: PointKind;
  emoji: string;
  color: string;
  /** valeur <sym> reconnue par Garmin pour afficher le bon pictogramme sur la montre */
  garminSym: string | null;
}

export const POINT_KINDS: PointKindDef[] = [
  { id: 'checkpoint', emoji: '•', color: '#e34948', garminSym: null },
  { id: 'eau', emoji: '💧', color: '#2a78d6', garminSym: 'Drinking Water' },
  { id: 'vue', emoji: '🌄', color: '#7c4dbe', garminSym: 'Scenic Area' },
  { id: 'pause', emoji: '☕', color: '#eda100', garminSym: 'Picnic Area' },
  { id: 'bivouac', emoji: '⛺', color: '#008300', garminSym: 'Campground' },
  { id: 'refuge', emoji: '🛖', color: '#8a5a2b', garminSym: 'Lodging' },
  { id: 'sommet', emoji: '⛰️', color: '#52514e', garminSym: 'Summit' },
  { id: 'autre', emoji: '📍', color: '#e87ba4', garminSym: 'Flag, Blue' },
];

export function kindLabelKey(kind: PointKind): MsgKey {
  return `kind_${kind}` as MsgKey;
}

export function kindDef(kind: PointKind): PointKindDef {
  return POINT_KINDS.find(k => k.id === kind) ?? POINT_KINDS[POINT_KINDS.length - 1];
}

export function kindFromGarminSym(sym: string | undefined): PointKind {
  return POINT_KINDS.find(k => k.garminSym === sym)?.id ?? 'autre';
}
