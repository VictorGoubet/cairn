import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** the dev build exposes the map and the store so tests can drive them without guessing pixels */
export interface TestHandles {
  __map: {
    jumpTo(options: { center: [number, number]; zoom: number }): void;
    getZoom(): number;
    getBearing(): number;
    getPitch(): number;
    getLayoutProperty(id: string, name: string): unknown;
    getStyle(): { layers: { id: string; type: string; 'source-layer'?: string }[] };
    project(lngLat: [number, number]): { x: number; y: number };
    getCenter(): { lng: number; lat: number };
    getMaxPitch(): number;
    getTerrain(): unknown;
    queryRenderedFeatures(options: { layers: string[] }): unknown[];
  };
  __planner: {
    getState(): PlannerHandle;
    setState(partial: Record<string, unknown>): void;
  };
}

interface PlannerHandle {
  anchors: { id: string; lon: number; lat: number; kind: string; name: string }[];
  legs: { leg: { coords: [number, number, number][]; distanceM: number } | null }[];
  offRoutePoints: { id: string; kind: string; name: string }[];
  overlays: Record<string, boolean>;
  savedRoutes: { id: string; name: string }[];
  clear(): void;
  addAnchor(p: [number, number]): void;
  undo(): void;
  redo(): void;
  toggleOverlay(name: string): void;
  setBaseLayerId(id: string): void;
  saveCurrentRoute(name: string): void;
}

/** Ceillac, Queyras: real trails around, so routing has something to snap onto */
export const CEILLAC: [number, number] = [6.7752, 44.6318];

// each test gets a fresh browser context, so localStorage starts empty on its own:
// clearing it on every navigation would also wipe the draft a reload is meant to restore
export async function openPlanner(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await page.waitForFunction(() => '__map' in window && '__planner' in window);
  await page.evaluate(center => {
    (window as unknown as TestHandles).__map.jumpTo({ center, zoom: 14 });
  }, CEILLAC);
  await page.waitForTimeout(1500);
}

export function planner(page: Page) {
  return {
    state: () =>
      page.evaluate(() => {
        const s = (window as unknown as TestHandles).__planner.getState();
        return {
          anchorCount: s.anchors.length,
          anchorKinds: s.anchors.map(a => a.kind),
          offRouteCount: s.offRoutePoints.length,
          legCoordCounts: s.legs.map(l => l.leg?.coords.length ?? 0),
          totalDistanceM: s.legs.reduce((sum, l) => sum + (l.leg?.distanceM ?? 0), 0),
          overlays: s.overlays,
          savedRouteNames: s.savedRoutes.map(r => r.name),
        };
      }),
    call: (method: keyof PlannerHandle, ...args: unknown[]) =>
      page.evaluate(
        ({ method, args }) => {
          const state = (window as unknown as TestHandles).__planner.getState() as unknown as Record<
            string,
            (...a: unknown[]) => void
          >;
          state[method](...args);
        },
        { method, args },
      ),
  };
}

/** waits until every leg has a geometry, which means routing settled */
export async function waitForRouting(page: Page, expectedLegs: number): Promise<void> {
  await page.waitForFunction(
    count => {
      const s = (window as unknown as TestHandles).__planner.getState();
      return s.legs.length === count && s.legs.every(l => (l.leg?.coords.length ?? 0) > 1);
    },
    expectedLegs,
    { timeout: 30_000 },
  );
}

/** clicks the map at a geographic position, letting maplibre do the projection */
export async function clickAt(page: Page, lngLat: [number, number], button: 'left' | 'right' = 'left'): Promise<void> {
  const point = await page.evaluate(ll => (window as unknown as TestHandles).__map.project(ll), lngLat);
  const box = await page.locator('.maplibregl-canvas').boundingBox();
  if (!box) throw new Error('map canvas has no box');
  await page.mouse.click(box.x + point.x, box.y + point.y, { button });
}
