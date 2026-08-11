<h1 align="center">⛰️ cairn</h1>

<p align="center">
  <strong>Free hiking route planner built on IGN open data</strong>
</p>

<p align="center">
  <em>No account, no server, everything runs in your browser</em>
</p>

<p align="center">
  <a href="https://cairn-swart-gamma.vercel.app">Live demo</a> •
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#stack">Stack</a> •
  <a href="#deploy">Deploy</a> •
  <a href="#roadmap">Roadmap</a>
</p>

<br>

## Features

- **IGN maps**: vector Plan IGN (crisp on hidpi), SCAN 25, aerial imagery, OSM
- **Trail-following routing**: click to draw, the route sticks to paths (BRouter, mountain hiking profile), or free-hand mode with IGN elevations
- **Elevation profile**: distance, gain/loss, way types and surfaces breakdown, estimated duration
- **Typed waypoints**: checkpoints, water, viewpoints, passes, stage ends... exported as GPX waypoints with Garmin symbols
- **Share by link**: the whole route is compressed into the URL fragment, no backend involved
- **Export and import**: GPX, KML, TCX out, GPX in with smart anchor extraction
- **3D terrain** with adaptive vertical exaggeration: plains stay readable, mountains stay realistic
- **Overlays**: hillshade, slope classes, GR/PR marked trails, discreet unmapped paths, mountain huts and water points (refuges.info)
- **No account**: drafts and saved routes live in your browser's localStorage
- **French and English**

## Quick Start

```bash
npm install
npm run dev
```

Quality gate (lint + typecheck + build):

```bash
make check
```

## Stack

| Layer | Choice |
|---|---|
| App | Vite + React + TypeScript, zustand |
| Map | MapLibre GL JS |
| Base maps | IGN Géoplateforme (Plan IGN, SCAN 25, ortho), OpenStreetMap |
| Routing | BRouter public server, custom mountain hiking profile |
| Geocoding and elevation | IGN Géoplateforme APIs |
| Terrain (3D, slopes, client-side elevations) | Terrarium DEM tiles (AWS Open Data) |
| POIs and hidden trails | refuges.info API, Overpass API |

Everything is queried straight from the browser: the deployed site is pure static files.

## Deploy

```bash
npm run build   # static output in dist/, deployable anywhere
```

Currently auto-deployed to [Vercel](https://cairn-swart-gamma.vercel.app) on every push to `main`.

## Roadmap

- [x] Route planner: IGN maps, elevation profile, search, undo/redo, insert-on-trace, out-and-back, loop, manual mode, km markers, GPX import
- [x] Typed waypoints, multi-format export (GPX/KML/TCX), share by link
- [x] Overlays: slopes, GR/PR, hidden trails, huts and water points, adaptive 3D
- [ ] Solid foundation: English codebase, full quality pass, e2e and regression tests
- [ ] Marked hikes around a point, Komoot style (OSM route=hiking relations)
- [ ] PWA + offline maps (PMTiles)
- [ ] Bivouac finder: slope score + water proximity + land cover
- [ ] Later, optional: direct upload to Garmin watches

## Data and credits

[IGN Géoplateforme](https://geoservices.ign.fr) • [OpenStreetMap](https://www.openstreetmap.org) • [BRouter](https://brouter.de) • [refuges.info](https://www.refuges.info) • [Terrarium DEM](https://registry.opendata.aws/terrain-tiles/) • [Waymarked Trails](https://hiking.waymarkedtrails.org)
