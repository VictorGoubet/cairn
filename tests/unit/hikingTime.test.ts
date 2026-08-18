import { describe, expect, it } from 'vitest';
import type { LonLatEle } from '../../src/lib/geo';
import { DEFAULT_PROFILE, durationH, energyKcal, speedMs } from '../../src/lib/hikingTime';

/** a track of `steps` segments of `runM` horizontal metres each, climbing `risePerStep` */
function track(steps: number, runM: number, risePerStep: number): LonLatEle[] {
  // 0.00001 degree of latitude is ~1.11 m, close enough to build a fixture of a known length
  const degPerM = 1 / 111_320;
  return Array.from({ length: steps + 1 }, (_, i) => [6.7, 44.6 + i * runM * degPerM, 1500 + i * risePerStep]);
}

describe('speedMs', () => {
  const kmh = (slope: number) => (speedMs(slope, DEFAULT_PROFILE) * 3600) / 1000;

  it('lands the flat speed on the Swiss Alpine Club scale', () => {
    expect(kmh(0)).toBeCloseTo(4.2, 1);
  });

  it('climbs at about the 400 m/h of the same scale', () => {
    // on a 20% slope, the vertical rate is the horizontal speed times the slope
    expect(kmh(0.2) * 0.2 * 1000).toBeGreaterThan(380);
    expect(kmh(0.2) * 0.2 * 1000).toBeLessThan(450);
  });

  it('walks a gentle descent faster than the flat, which the linear rules cannot', () => {
    expect(kmh(-0.05)).toBeGreaterThan(kmh(0));
    // and a steep descent slower than the flat again
    expect(kmh(-0.35)).toBeLessThan(kmh(0));
  });

  it('peaks at the -5% slope of Tobler\'s function', () => {
    expect(kmh(-0.05)).toBeGreaterThan(kmh(-0.15));
    expect(kmh(-0.05)).toBeGreaterThan(kmh(0.05));
  });

  it('follows the pace setting, and slows under a heavy pack', () => {
    const strolling = speedMs(0, { ...DEFAULT_PROFILE, pace: 'strolling' });
    const athletic = speedMs(0, { ...DEFAULT_PROFILE, pace: 'athletic' });
    expect(athletic).toBeGreaterThan(strolling * 1.5);
    const loaded = speedMs(0, { ...DEFAULT_PROFILE, packKg: 20 });
    expect(loaded).toBeLessThan(speedMs(0, { ...DEFAULT_PROFILE, packKg: 0 }));
  });
});

describe('durationH', () => {
  it('gives 5 km on the flat in about 1h10, the SAC pace', () => {
    expect(durationH(track(50, 100, 0))).toBeCloseTo(5 / 4.2, 1);
  });

  it('prices a 600 m climb close to Naismith, once his faster base pace is accounted for', () => {
    // 3 km horizontal, 600 m up (20% average): Naismith gives 0.6 h walking + 1 h climbing
    const hours = durationH(track(30, 100, 20));
    expect(hours).toBeGreaterThan(1.4);
    expect(hours).toBeLessThan(2.2);
  });

  it('sees the difference between a gentle and a steep descent of the same drop', () => {
    const gentle = durationH(track(60, 100, -10)); // 6 km, -600 m
    const steep = durationH(track(20, 100, -30)); // 2 km, -600 m
    expect(steep).toBeLessThan(gentle);
    // the steep one is 4 km shorter yet not four times quicker: the slope costs
    expect(steep).toBeGreaterThan(gentle / 3);
  });

  it('is monotonic in distance and returns nothing for a single point', () => {
    expect(durationH(track(100, 100, 0))).toBeGreaterThan(durationH(track(50, 100, 0)));
    expect(durationH([[6.7, 44.6, 1500]])).toBe(0);
  });
});

describe('energyKcal', () => {
  it('costs a plausible number of calories for a real day out', () => {
    // 12 km with 800 m of climb, 72 kg hiker with an 8 kg pack. Pandolf sits at the low end of
    // the MET tables for walking, so the bracket is wide on purpose: what is asserted is that the
    // number is a day of hiking, not a coffee break and not a marathon
    const climb = track(40, 100, 20); // 4 km, +800 m
    const flat = track(80, 100, 0); // 8 km
    const kcal = energyKcal(climb) + energyKcal(flat);
    expect(kcal).toBeGreaterThan(1200);
    expect(kcal).toBeLessThan(4000);
  });

  it('grows with body mass and with the pack', () => {
    const route = track(40, 100, 20);
    expect(energyKcal(route, { ...DEFAULT_PROFILE, weightKg: 90 })).toBeGreaterThan(
      energyKcal(route, { ...DEFAULT_PROFILE, weightKg: 60 }),
    );
    expect(energyKcal(route, { ...DEFAULT_PROFILE, packKg: 18 })).toBeGreaterThan(
      energyKcal(route, { ...DEFAULT_PROFILE, packKg: 3 }),
    );
  });

  it('never goes negative on a descent, which the raw Pandolf equation does', () => {
    expect(energyKcal(track(40, 100, -20))).toBeGreaterThan(0);
  });
});
