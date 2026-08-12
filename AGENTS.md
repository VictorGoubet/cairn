# AGENTS.md - cairn

Stable knowledge for humans and AI agents working on this repo. The README covers what the
app does; this file covers how it works inside and the hard-won gotchas. The code is the
source of truth for specifics.

## Mission

Free hiking route planner on IGN open data. Goal: match and beat OpenRunner/Komoot on hiking,
while staying free, open data, and 100% client-side (static hosting, no backend, no account).
Plan for many users: every external API is queried from the user's browser, so be gentle with
free services (tile-grid caching, debouncing, LRU).

## Commands

The Makefile is the only dev entry point; never call npm or pnpm directly (pnpm is the
package manager underneath, lockfile `pnpm-lock.yaml`).

- `make setup` / `make dev` / `make build`: install deps + playwright browser / dev server / static build in `dist/`
- `make check`: the quality gate (lint biome + typecheck tsc + unit tests + build)
- `make format`: auto-fix formatting + lint before committing
- `make test`: unit and regression tests (vitest + jsdom, `tests/`)
- `make test-e2e`: browser tests (playwright, `e2e/`); starts its own dev server on port 4321

## Tests

- `tests/**/*.test.ts`: the pure modules, where regressions hurt most. Storage and share
  migrations are covered kind by kind, since a rename there silently breaks saved routes.
- `e2e/planner.spec.ts`: the critical paths (draw, insert on trace, undo/redo including the
  mouse back button, POIs, overlays, 3D, save and reload, click-outside, language switch).
  Every past regression gets a test here, that is the point of the file.
- e2e drive the app through `window.__planner` and `window.__map`, exposed in dev builds
  only: clicking real pixels is projected via `map.project` (see `e2e/helpers.ts`), never
  hardcoded. They hit live services, hence one retry and generous timeouts.

## Architecture

- `src/store.ts`: zustand store; anchors + legs model, history (undo/redo), drag logic,
  import/share/save actions. One `LegSlot` between each pair of anchors.
- `src/components/MapView.tsx`: all MapLibre wiring; layers, overlays, markers, terrain,
  drag interactions.
- `src/lib/`: pure logic, one module per concern; `brouter` (routing), `share` (link
  encoding), `gpx` + `exportFormats` (GPX/KML/TCX), `routeSplice` (insert point in trace),
  `demElevation` (client-side DEM reads), `storage` (localStorage + migrations),
  `hiddenTrails` / `refugesInfo` (on-the-fly overlays), `tileGrid` (per-cell caching).

### Core model

- An **anchor** is a route point, optionally typed (checkpoint, water, viewpoint…). POIs are
  regular anchors with metadata, they always sit on the trace.
- **Off-route points** are independent markers (right-click), not part of the trace.
- A **leg** owns its geometry. `manual: true` means "geometry is frozen, never re-route it"
  (GPX import, manual mode, out-and-back). `manual: false` legs are recomputed via BRouter.
- Never trust a leg's `manual` flag to decide how to *recompute*: recomputation follows the
  store's `manualMode` at the time of the change.

## Key algorithms & decisions

- **GPX import**: Ramer-Douglas-Peucker picks anchors from the track; original geometry is
  preserved in frozen legs. Imported waypoints snap to the trace when within 100 m, else they
  become off-route points.
- **Anchor drag**: elastic line during drag, re-route throttled at 450 ms (Leaflet Routing
  Machine's cadence), snap-on-drop to the router's junction.
- **Share links** (`src/lib/share.ts`): payload `#r=1.<base64url(deflate-raw(JSON))>`.
  Routed legs travel as anchors only (recomputed on open); frozen legs travel as a polyline
  (Google algorithm, lat/lon at 1e-5, elevation at 0.1 m). `''` = manual leg still computing
  at share time. Opening a link pushes the current draft to history (one undo away).
- **Adaptive 3D exaggeration** (`MapView.tsx`): classic cartography rule (Imhof), flat
  terrain needs 2-3x, alpine reads at ~1x. On map idle, sample a viewport grid via
  `queryTerrainElevation` (zero network) and target relief ≈ 5% of viewport width,
  clamped to [1.1, 3].
- **Client-side elevations** (`demElevation.ts`): Terrarium tiles at z13, bilinear
  interpolation, LRU of 64 decoded tiles. No calls to the IGN altimetry API except for
  manual legs' profiles (`elevation.ts`).
- **Overlay data** (hidden trails, refuges.info): fetched per tile-grid cell (z11 Overpass,
  z9 refuges.info) with an LRU cache, refreshed on `moveend`, only while the overlay is on.
- **localStorage**: draft + saved routes, versioned and migrated in `storage.ts`. Any schema
  change needs a migration path there.

## Gotchas (learned the hard way)

- **MapLibre v6 worker must be bundled**: the dist worker imports a sibling
  `maplibre-gl-shared.mjs`, so a plain `?url` asset 404s/dies in production (blank map,
  UI fine, no console error). Keep the `?worker&url` import + `setWorkerUrl(...)` in
  `MapView.tsx`. Symptom to recognize: worker created then immediately closed.
- `setTerrain` needs its **own raster-dem source**: sharing the hillshade source degrades
  rendering (see `terrain-3d` vs `terrain-dem` sources).
- `queryTerrainElevation` returns **exaggerated** elevations: divide by the applied
  exaggeration before doing math.
- Enabling 3D forces hillshade on (3D without shading is unreadable); the toggle logic in
  `store.ts#toggleOverlay` is order-sensitive.
- Vite HMR must **full-reload on store changes** (`import.meta.hot.invalidate()` in
  `store.ts`), otherwise components keep references to a dead store ("undo stops working").
- The IGN vector style is patched at load in `buildStyle()` (MapView): layer visibility is
  driven per-layer, contours and hybrid mode depend on it.

## Mobile layout

- Breakpoint `(max-width: 760px)` (`src/lib/useMediaQuery.ts`). `App` renders two distinct
  trees rather than bending one with CSS: the desktop split view, or the map plus a bottom
  sheet. `RouteStats` is shared so distance, gain and save cannot drift apart.
- The sheet (`components/BottomSheet.tsx`) has three stops, peek / half / full, draggable by
  its grip or selectable by the dots. `App` mirrors the current stop on `data-sheet` so the
  map controls can dodge it, and hide entirely at full.
- Touch replaces what a mouse gave us: a tap appends a point, a long press (500 ms, 12 px of
  slop) drops an off-route point like the right click, and it suppresses the click that
  follows so a POI is not doubled with a route point.
- Actions collapse behind one menu button, so the bar stays a single line on a 320 px screen.
- Mobile e2e run under Chromium with touch emulation, not a webkit device preset, so
  `make setup` keeps downloading a single browser.

## Interaction map

- Left click or tap appends a point, clicking the track inserts one, right click or long press
  drops an off-route point, dragging a point re-routes it live.
- Right button or middle button held rotates and tilts (`lib/mapGestures.ts`); the middle
  button is wired by hand since MapLibre only ships the right one.
- Escape closes whatever floats (`lib/useEscapeKey.ts`, alongside `useClickOutside`) and stops
  the flyover. Backspace and the mouse back button undo.
- Selecting a stretch on the profile stores it (`profileSelection`) and the map draws it over
  the route, so numbers and geometry always agree.
- Points reorder by dragging their row; `reorderAnchor` recomputes the legs around both
  positions and leaves frozen legs alone.
- The play button flies the route like a drone (`lib/flyover.ts`): constant ground speed,
  smoothed bearing looking ahead, terrain forced on and the camera restored on exit.
- Map control buttons carry `data-control` so tests never depend on their order or labels.

## Known trade-offs

- **Back navigation is undo.** A stack of history sentinels turns the browser back button,
  the trackpad gesture and the mouse thumb button into undo, and refills itself so the
  gesture keeps working. Deliberate: it matches the mouse-button undo of desktop editors.
  The cost is real, a visitor cannot leave the planner with the back button.
- **Slope at DEM tile borders** is a one-sided derivative: the neighboring tile is not read,
  so the border pixel is slightly less accurate than the interior (it used to be understated
  by half, which read as flat ground).
- **`MapView.tsx` is the big file** (~690 lines). The extraction candidates are known and low
  risk: `buildStyle`, the POI overlay refresh, `adaptiveExaggeration`, the marker element
  builders. Not done yet, on purpose, to keep this pass reviewable.

## Conventions

- The codebase is English: identifiers, comments, docs, internal error messages. French
  survives only as data: the `fr` dictionary in `src/lib/i18n.ts`, department names, and the
  literal keys of French APIs (refuges.info types, IGN categories).
- UI is bilingual: every user-facing string goes through `src/lib/i18n.ts` (fr + en keys).
- Point kinds are stored in saved routes and share links: renaming one means teaching
  `parseKind` (`src/lib/points.ts`) the old spelling, never dropping it.
- Comments and docs describe the present, not the journey; keep them one line when possible.
- Writing style: no em dashes anywhere (code, docs, UI copy), and no emojis in docs or UI
  text; the only emoji lives in the brand header (⛰️ cairn).
- Commits: English, short, lowercase, imperative-ish (`fix: …`, `chore: …`, `roadmap: …`).
  No `Co-authored-by` trailers.
- Lean and YAGNI: no route variants, no speculative options. New overlays follow the
  tile-grid + LRU pattern.

## Hosting

- Auto-deployed to Vercel (project `victorgoubet1s-projects/cairn`) on every push to `main`;
  production alias: https://cairn-swart-gamma.vercel.app
- Pure static output: no env vars, no rewrites (share links live in the URL fragment).
- Vercel Hobby limits: 100 GB/month bandwidth, non-commercial only. Migration candidate if
  traffic grows or monetization appears: Cloudflare Pages (unlimited bandwidth, commercial OK).
