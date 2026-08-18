<p align="center">
  <img src="public/logo.png" alt="cairn" width="110" />
</p>

<h1 align="center">cairn</h1>

<p align="center">
  <strong>Free hiking route planner built on IGN open data</strong>
</p>

<p align="center">
  <em>No account, no server, everything runs in your browser</em>
</p>

<p align="center">
  <a href="https://github.com/VictorGoubet/cairn/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/VictorGoubet/cairn/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

<p align="center">
  <a href="https://cairn-swart-gamma.vercel.app">Live demo</a> •
  <a href="#quick-start">Quick start</a> •
  <a href="#stack">Stack</a> •
  <a href="#development">Development</a> •
  <a href="#deploy">Deploy</a>
</p>

<br>

Draw a hiking route that follows real trails, over official IGN maps. Elevation profile, typed
waypoints, marked routes around you, 3D flyover, follow mode on the trail, GPX/KML/TCX export,
share by link or as a social image. Built entirely on open data (IGN Géoplateforme, OpenStreetMap, refuges.info)
and queried straight from your browser: no backend, no account, no personal tracking.

## Quick start

Node 22 and pnpm, then:

```bash
make setup   # dependencies, the playwright browser, the git hooks
make dev     # http://localhost:5173
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
| Analytics | Umami, cookieless and open source, production domain only |

Everything is queried straight from the browser: the deployed site is pure static files.

## Development

`make` is the only entry point; run `make` alone for the list.

| Command | What it does |
| --- | --- |
| `make check` | the gate CI runs: lint, types, unit tests, build |
| `make format` | fixes formatting and lint (biome) |
| `make test` | unit and regression tests (vitest) |
| `make test-e2e` | browser suite (playwright, real APIs) |

A pre-commit hook lints the staged files, and CI runs `make check` on every push. The
end-to-end suite queries IGN, BRouter and Overpass, so it stays a local command rather than a
pipeline that goes red when a free API hiccups.

[ARCHITECTURE.md](ARCHITECTURE.md) documents the internals: layout, interaction map,
conventions and known trade-offs.

## Deploy

```bash
make build
```

Static output in `dist/`, deployable anywhere.

Currently auto-deployed to [Vercel](https://cairn-swart-gamma.vercel.app) on every push to `main`.

## License

MIT, see [LICENSE](LICENSE).

## Data and credits

[IGN Géoplateforme](https://geoservices.ign.fr) • [OpenStreetMap](https://www.openstreetmap.org) • [BRouter](https://brouter.de) • [refuges.info](https://www.refuges.info) • [Terrarium DEM](https://registry.opendata.aws/terrain-tiles/) • [Waymarked Trails](https://hiking.waymarkedtrails.org)
