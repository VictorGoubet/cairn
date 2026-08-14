import { describe, expect, it } from 'vitest';
import { kindDef, kindFromGarminSym, kindLabelKey, parseKind, POINT_KINDS } from '../../src/lib/points';

describe('parseKind', () => {
  it('accepts current identifiers unchanged', () => {
    for (const kind of POINT_KINDS) {
      expect(parseKind(kind.id)).toBe(kind.id);
    }
  });

  it('migrates the french identifiers stored by older versions', () => {
    expect(parseKind('eau')).toBe('water');
    expect(parseKind('vue')).toBe('viewpoint');
    expect(parseKind('pause')).toBe('break');
    expect(parseKind('bivouac')).toBe('camp');
    expect(parseKind('refuge')).toBe('hut');
    expect(parseKind('sommet')).toBe('summit');
    expect(parseKind('autre')).toBe('other');
  });

  it('maps the retired stage-end kind onto camp', () => {
    expect(parseKind('etape')).toBe('camp');
  });

  it('falls back to other on unknown or missing input', () => {
    expect(parseKind('teleporter')).toBe('other');
    expect(parseKind(undefined)).toBe('other');
    expect(parseKind('')).toBe('other');
  });
});

describe('kind metadata', () => {
  it('gives every kind an emoji, a color and a translation key', () => {
    for (const kind of POINT_KINDS) {
      expect(kind.emoji).not.toBe('');
      expect(kind.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(kindLabelKey(kind.id)).toBe(`kind_${kind.id}`);
    }
  });

  it('keeps checkpoint out of GPX waypoints and gives the others a garmin symbol', () => {
    expect(kindDef('checkpoint').garminSym).toBeNull();
    for (const kind of POINT_KINDS.filter(k => k.id !== 'checkpoint')) {
      expect(kind.garminSym).toBeTruthy();
    }
  });

  it('round-trips through garmin symbols', () => {
    for (const kind of POINT_KINDS.filter(k => k.garminSym)) {
      expect(kindFromGarminSym(kind.garminSym as string)).toBe(kind.id);
    }
    expect(kindFromGarminSym('Unknown Symbol')).toBe('other');
    expect(kindFromGarminSym(undefined)).toBe('other');
  });
});
