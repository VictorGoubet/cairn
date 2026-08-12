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
- The play button flies the route like a drone (`lib/flyover.ts`). It follows the two-path
  technique Mapbox documents for camera paths: the camera rides the track while a second point
  runs ahead, and `calculateCameraOptionsFromTo` derives center, zoom, pitch and bearing from
  that geometry (MapLibre has no FreeCameraOptions). What that buys, and what it cost to learn:
  - **Framing is calibrated, not guessed.** Looking 1150 m ahead from 220 m up lands near zoom
    15.5 and pitch 79 at our latitudes, the low grazing pass; the height-to-lookahead ratio is
    kept so short routes stay framed the same way. Going closer derives a zoom past 16.5, where
    tiles stop keeping up, which is also why the look-ahead has a floor: a one kilometre route
    would otherwise frame a hedge. The pitch cap stays at 82, since nearer the horizon the near
    plane starts clipping the ground.
  - **Height is measured from the target, not from the ground under the camera.** Pitch is
    `atan(ahead / drop onto the target)`, so a climb that outruns the smoothed altitude tips the
    camera uphill into the sky and the derived pitch pins to the cap. A floor on that drop holds
    the framing while the smoothing catches up.
  - **The path is resampled and averaged** (25 m step, 150 m window) before the camera flies it.
    Switchbacks and GPS wobble otherwise shake the heading: measured frame-to-frame bearing jerk
    fell from 0.89 deg mean / 2.6 max to 0.19 / 0.9. Elevation is left as sampled, so clearing
    the relief still works on the real profile.
  - **Smoothing is per metre flown, never per frame.** A constant applied per frame means one thing
    at 60 fps and another at 25, so the camera would shake hardest on the machines that are
    already struggling, and it would change again with the ground speed.
  - **The camera moves on every frame.** Throttling it to 30 fps looks like stutter rather than
    like an economy: the frames that are kept do not line up with the display's refresh.
  - **Terrain exaggeration is pinned to 1** while flying. MapLibre drops the closest tiles with
    terrain on and it worsens sharply with exaggeration (maplibre-gl-js issue 1241), which is
    exactly the "chunks vanishing" symptom.
  - **The initial jump is applied twice**: the first one lands short with terrain on
    (maplibre-gl-js issue 4688).
  - **The camera clears the relief ahead**, not just the ground under it, or a climb pushes the
    derived pitch towards the sky.
  - **The flight is its own scene**, set up in `MapView` and restored on exit, and each difference
    from the planner view is also what pays for the frame rate:
    - satellite imagery (`FLYOVER_BASE_LAYER`), because a drawn map has nothing to show from
      200 m up, and because raster tiles skip the vector work;
    - **no labels**: laying out symbols over a tilted view is the most expensive thing on screen,
      and the ones that survive the camera pop in and out;
    - **no markers**: with terrain on, every DOM marker asks MapLibre for the elevation of its
      position on every frame, and a long route carries dozens of them;
    - **a DEM capped two zooms coarser** (`terrain-flyover`, maxzoom 13), where one tile stands in
      for sixteen: a moving camera needs a whole valley's elevation at once;
    - **one device pixel instead of two**, a quarter of the pixels to shade, which is where the
      frame budget goes on a 4K screen;
    - hillshading, slope tiles, Overpass and refuges off: the first is only there to make the pale
      plan readable, the others recompute on every viewport change.
  - **Raster base layers carry `raster-fade-duration: 0`.** The default cross-fade reads as the
    imagery blinking once the camera is moving.
  - **Playback time comes from a ground speed cap, not from a target duration.** Holding a route
    to a fixed number of seconds would mean flying a long one so fast that the imagery cannot
    arrive; the cap is the honest limit, and a short route is stretched to a floor instead.
- The style carries a `sky` and a `background` layer. Without the sky, everything above the
  horizon is unpainted and the page shows through as soon as the camera tilts.
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
