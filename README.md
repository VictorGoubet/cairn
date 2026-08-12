<h1 align="center">⛰️ cairn</h1>

<p align="center">
  <strong>Free hiking route planner built on IGN open data</strong>
</p>

<p align="center">
  <em>No account, no server, everything runs in your browser</em>
</p>

<p align="center">
  <a href="https://cairn-swart-gamma.vercel.app">Live demo</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#stack">Stack</a> •
  <a href="#deploy">Deploy</a> •
  <a href="#roadmap">Roadmap</a>
</p>

<br>

Draw a hiking route that follows real trails, over official IGN maps. Elevation profile,
typed waypoints, GPX/KML/TCX export, share by link. Built entirely on open data (IGN
Géoplateforme, OpenStreetMap, refuges.info) and queried straight from your browser:
no backend, no account, no tracking.

## Quick Start

```bash
make setup
make dev
```

Quality gate (lint + typecheck + unit tests + build):

```bash
make check
```

Browser tests:

```bash
make test-e2e
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
| Tests | vitest + jsdom (unit), playwright (e2e) |

Everything is queried straight from the browser: the deployed site is pure static files.

## Deploy

```bash
make build
```

Static output in `dist/`, deployable anywhere.

Currently auto-deployed to [Vercel](https://cairn-swart-gamma.vercel.app) on every push to `main`.

## Roadmap

- [x] Route planner: IGN maps, elevation profile, search, undo/redo, insert-on-trace, out-and-back, loop, manual mode, km markers, GPX import
- [x] Typed waypoints, multi-format export (GPX/KML/TCX), share by link
- [x] Overlays: slopes, GR/PR, hidden trails, huts and water points, adaptive 3D
- [x] Solid foundation: English codebase, full quality pass, e2e and regression tests
- [ ] Mobile-first responsive interface: plan and follow a hike from a phone
- [ ] Marked hikes around a point, Komoot style (OSM route=hiking relations)
- [ ] PWA + offline maps (PMTiles)
- [ ] Later, optional: direct upload to Garmin watches

## Data and credits

[IGN Géoplateforme](https://geoservices.ign.fr) • [OpenStreetMap](https://www.openstreetmap.org) • [BRouter](https://brouter.de) • [refuges.info](https://www.refuges.info) • [Terrarium DEM](https://registry.opendata.aws/terrain-tiles/) • [Waymarked Trails](https://hiking.waymarkedtrails.org)
