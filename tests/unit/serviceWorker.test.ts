import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OFFLINE_CACHE } from '../../src/lib/offline';

const SW = readFileSync('public/sw.js', 'utf8');
const KEEP = SW.match(/const keep = \[(.+?)\]/s)?.[1] ?? '';

describe('the worker and the caches the app fills itself', () => {
  it('keeps every cache the app writes to, since activate deletes the rest', () => {
    // the cost of getting this wrong is silent: a deploy activates a new worker, which wipes the
    // cache it was not told about, and the gallery redraws every thumbnail from tiles again
    const names = [...SW.matchAll(/const (\w*CACHE) = '([^']+)'/g)].map(m => ({ constant: m[1], value: m[2] }));
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const { constant } of names) expect(KEEP).toContain(constant);
    expect(names.map(n => n.value)).toContain('cairn-thumbs-v1');
    // the offline bundle name is written on both sides of the worker boundary and must agree
    expect(names.map(n => n.value)).toContain(OFFLINE_CACHE);
  });
});
