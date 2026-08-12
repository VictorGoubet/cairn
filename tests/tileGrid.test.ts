import { describe, expect, it } from 'vitest';
import { cachedFetch, type Cell, cellBounds, cellsInBounds } from '../src/lib/tileGrid';

describe('cellsInBounds', () => {
  it('covers a small viewport with a single cell', () => {
    const cells = cellsInBounds({ west: 6.5, south: 44.6, east: 6.51, north: 44.61 }, 9);
    expect(cells).toHaveLength(1);
  });

  it('grows with the viewport and with the zoom level', () => {
    const bounds = { west: 5, south: 44, east: 7, north: 46 };
    expect(cellsInBounds(bounds, 9).length).toBeGreaterThan(1);
    expect(cellsInBounds(bounds, 11).length).toBeGreaterThan(cellsInBounds(bounds, 9).length);
  });

  it('round-trips a cell through its own bounds', () => {
    const cell = cellsInBounds({ west: 6.5, south: 44.6, east: 6.51, north: 44.61 }, 9)[0];
    const bounds = cellBounds(cell, 9);
    expect(bounds.west).toBeLessThanOrEqual(6.5);
    expect(bounds.east).toBeGreaterThanOrEqual(6.51);
    expect(bounds.south).toBeLessThanOrEqual(44.6);
    expect(bounds.north).toBeGreaterThanOrEqual(44.61);
    expect(cellsInBounds(bounds, 9)).toEqual(expect.arrayContaining<Cell>([cell]));
  });
});

describe('cachedFetch', () => {
  it('runs the fetcher once per key', async () => {
    const cache = new Map<string, Promise<number>>();
    let calls = 0;
    const fetcher = () => {
      calls++;
      return Promise.resolve(calls);
    };

    await cachedFetch(cache, 'a', 4, fetcher);
    await cachedFetch(cache, 'a', 4, fetcher);
    expect(calls).toBe(1);

    await cachedFetch(cache, 'b', 4, fetcher);
    expect(calls).toBe(2);
  });

  it('evicts the oldest entries beyond the cap', async () => {
    const cache = new Map<string, Promise<string>>();
    for (const key of ['a', 'b', 'c']) {
      await cachedFetch(cache, key, 2, () => Promise.resolve(key));
    }
    expect(cache.size).toBeLessThanOrEqual(2);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('forgets failures so the next call can retry', async () => {
    const cache = new Map<string, Promise<string>>();
    let attempts = 0;
    const flaky = () => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok');
    };

    await expect(cachedFetch(cache, 'k', 4, flaky)).rejects.toThrow('boom');
    await expect(cachedFetch(cache, 'k', 4, flaky)).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });
});
