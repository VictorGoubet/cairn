# cairn

Planificateur de randonnée et de trek, 100% gratuit, construit sur de l'open data.

Créer un itinéraire sur les cartes IGN en quelques clics, voir le profil altimétrique, poser des points d'intérêt, exporter le GPX vers une montre GPS.

Le planner : recherche de lieu, tracé qui suit les sentiers (ou ligne droite hors sentier avec altitudes IGN), insertion de points en cliquant sur la trace, undo/redo (Cmd+Z), retour arrière pour annuler le dernier point, inverser, aller-retour, boucler, bornes kilométriques, stats (distance, D+/D-, altitudes, durée estimée), import GPX, export GPX/KML/TCX.

Fonds : Plan IGN vectoriel (net en hidpi), SCAN 25, ortho, OSM. Overlays : estompage du relief, pentes fines calculées dans le navigateur depuis le MNT (classes pensées bivouac, 0-3° = posable), sentiers balisés GR/PR (Waymarked Trails).

Points typés pour la montre : checkpoints de tracé, points d'intérêt (eau, vue, pause, bivouac, sommet) et fins d'étape, exportés en waypoints GPX avec les symboles Garmin.

Aucun compte : le brouillon en cours et « Mes itinéraires » sont stockés dans le navigateur (localStorage). L'export GPX reste là pour la montre, et le bouton Partager encode l'itinéraire complet dans un lien (compression dans le fragment d'URL, aucun serveur).

## Stack

- Vite + React + TypeScript, MapLibre GL, zustand
- Fonds de carte : IGN Géoplateforme (Plan IGN, SCAN 25, ortho) et OpenStreetMap
- Routage : BRouter (serveur public, profil rando montagne)
- Géocodage et altimétrie : APIs Géoplateforme IGN

## Dev

```sh
npm install
npm run dev
```

## Build

```sh
npm run build   # sortie statique dans dist/, déployable partout (Vercel, nginx, ...)
```

## Roadmap

- [x] Création d'itinéraire sur fonds IGN, profil altimétrique, waypoints, export GPX
- [x] Planner complet : recherche, undo/redo, insertion sur trace, aller-retour/boucle, mode hors sentier, bornes km, durée estimée, import GPX
- [x] Points d'eau, sources et refuges (OSM Overpass, refuges.info), partage d'itinéraire par lien
- [ ] Base solide : tout le code, commentaires et doc en anglais ; revue complète design / qualité / DRY / lean ; tests e2e et de régression
- [ ] Randos balisées autour d'un point, style Komoot (relations OSM route=hiking)
- [ ] PWA + cartes offline (PMTiles)
- [ ] Bivouac finder : score pente + proximité eau + occupation du sol sur carte relief
- [ ] Plus tard, en option : envoi direct vers montre Garmin
