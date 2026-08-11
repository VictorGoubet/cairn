import { create } from 'zustand';
import { DEFAULT_BASE_LAYER } from './config/layers';
import {
  computeLeg,
  computeRoute,
  type RouteLeg,
  type RoutingPreset,
  setRoutingPreset as setBrouterPreset,
  splitRoute,
  straightLeg,
} from './lib/brouter';
import { sampleElevations } from './lib/demElevation';
import { elevationLine } from './lib/elevation';
import {
  elevationStats,
  haversineM,
  type LonLat,
  type LonLatEle,
  pathDistanceM,
  pointToPathDistanceM,
  simplifyIndices,
} from './lib/geo';
import type { MsgKey } from './lib/i18n';
import { detectLang, type Lang, persistLang } from './lib/lang';
import type { PointKind } from './lib/points';
import { spliceIntoTrace } from './lib/routeSplice';
import { loadDraft, loadRoutes, persistDraft, persistRoutes } from './lib/storage';

const HISTORY_LIMIT = 50;
const MAX_IMPORT_ANCHORS = 40;
const IMPORT_ANCHOR_TOLERANCE_M = 25;
// au-delà de cette distance à la trace, un <wpt> importé reste un repère hors tracé
const IMPORT_WPT_SNAP_M = 100;
// adoption du routage d'un tronçon importé: il doit coller à la trace d'origine
const MATCH_MAX_DEVIATION_M = 30;
const MATCH_MIN_FRACTION = 0.85;
const MATCH_MAX_LENGTH_RATIO = 0.2;

export interface Anchor {
  id: string;
  lon: number;
  lat: number;
  kind: PointKind;
  name: string;
}

/** repère libre posé au clic droit (source, vue...): informatif, sans influence sur l'itinéraire */
export interface OffRoutePoint {
  id: string;
  lon: number;
  lat: number;
  kind: PointKind;
  name: string;
}

export interface LegSlot {
  id: string;
  /** comment calculer ce tronçon s'il reste à calculer; sans effet sur une géométrie déjà figée (import, aller-retour) */
  manual: boolean;
  leg: RouteLeg | null;
}

export type FlyTo = { center: LonLat; zoom: number } | { bounds: [LonLat, LonLat] };

/** dimension et valeur mises en surbrillance sur la carte au survol des légendes */
export type WayHighlight = { dim: 'category' | 'surface'; value: string };

export interface SavedRoute {
  id: string;
  name: string;
  updatedAt: string;
  distanceM: number;
  gainM: number;
  anchors: Anchor[];
  legs: LegSlot[];
  offRoutePoints: OffRoutePoint[];
}

interface Snapshot {
  anchors: Anchor[];
  legs: LegSlot[];
  offRoutePoints: OffRoutePoint[];
}

/** route décodée depuis un lien de partage (voir lib/share.ts) */
export interface SharedRouteInput {
  name: string;
  preset?: RoutingPreset;
  anchors: Anchor[];
  legs: LegSlot[];
  offRoutePoints: OffRoutePoint[];
}

export interface Overlays {
  km: boolean;
  contours: boolean;
  hillshade: boolean;
  slopes: boolean;
  gr: boolean;
  hidden: boolean;
  refuges: boolean;
  terrain3d: boolean;
}

interface PlannerState {
  lang: Lang;
  baseLayerId: string;
  overlays: Overlays;
  manualMode: boolean;
  routingPreset: RoutingPreset;
  wayTypeHighlight: WayHighlight | null;
  anchors: Anchor[];
  legs: LegSlot[];
  offRoutePoints: OffRoutePoint[];
  history: Snapshot[];
  future: Snapshot[];
  savedRoutes: SavedRoute[];
  currentRouteId: string | null;
  currentRouteName: string;
  showRoutes: boolean;
  /** id du point (ancre ou hors tracé) en cours d'édition dans le panneau de métadonnées */
  editing: string | null;
  hoverPoint: LonLat | null;
  flyTo: FlyTo | null;
  error: MsgKey | null;
  setLang: (lang: Lang) => void;
  addAnchor: (p: LonLat) => void;
  insertAnchor: (p: LonLat) => void;
  beginDragAnchor: () => void;
  dragAnchor: (index: number, p: LonLat) => void;
  moveAnchor: (index: number, p: LonLat) => void;
  removeAnchor: (id: string) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  reverse: () => void;
  outAndBack: () => void;
  closeLoop: () => void;
  importRoute: (coords: LonLatEle[], waypoints: { lon: number; lat: number; name: string; kind: PointKind }[]) => void;
  applySharedRoute: (route: SharedRouteInput) => void;
  addOffRoutePoint: (p: LonLat) => void;
  moveOffRoutePoint: (id: string, p: LonLat) => void;
  removeOffRoutePoint: (id: string) => void;
  setEditing: (id: string | null) => void;
  updateEditingPoint: (kind: PointKind, name: string) => void;
  removeEditingPoint: () => void;
  saveCurrentRoute: (name: string) => void;
  loadRoute: (id: string) => void;
  deleteRoute: (id: string) => void;
  toggleRoutesPanel: () => void;
  retryLegs: () => void;
  focusRoute: () => void;
  setManualMode: (manual: boolean) => void;
  setRoutingPreset: (preset: RoutingPreset) => void;
  setWayTypeHighlight: (highlight: WayHighlight | null) => void;
  setBaseLayerId: (id: string) => void;
  toggleOverlay: (name: keyof Overlays) => void;
  setHoverPoint: (p: LonLat | null) => void;
  setFlyTo: (target: FlyTo | null) => void;
  dismissError: () => void;
}

const inFlight = new Set<string>();
let editingDirty = false;
// drag "latest-wins": une seule requête de routage en vol, toujours relancée sur la dernière position
let draggingAnchor = false;
let dragBusy = false;
let dragNextPos: { index: number; p: LonLat } | null = null;
// invalide les re-routages de préréglage devenus obsolètes
let rerouteToken = 0;

export const usePlanner = create<PlannerState>((set, get) => {
  function newSlot(manual: boolean): LegSlot {
    return { id: crypto.randomUUID(), manual, leg: null };
  }

  function newAnchor(p: LonLat, kind: PointKind = 'checkpoint'): Anchor {
    return { id: crypto.randomUUID(), lon: p[0], lat: p[1], kind, name: '' };
  }

  // chaque tronçon a un id: une réponse réseau qui arrive après un undo/clear ne trouve plus son slot.
  // snap: le routeur recale les extrémités sur le sentier le plus proche; l'ancre concernée est
  // aimantée sur la géométrie calculée pour ne jamais rester flottante à côté de sa propre trace
  function launchLeg(slot: LegSlot, from: LonLat, to: LonLat, snap?: { anchorId: string; end: 'start' | 'end' }) {
    if (inFlight.has(slot.id)) return;
    inFlight.add(slot.id);
    const promise = slot.manual
      ? computeManualLeg(from, to)
      : computeLeg(from, to).catch(() => {
          set({ error: 'err_routing' });
          return computeManualLeg(from, to);
        });
    promise
      .then(leg => {
        set(s => ({ legs: s.legs.map(l => (l.id === slot.id ? { ...l, leg } : l)) }));
        if (!snap || slot.manual || leg.coords.length === 0) return;
        const p = snap.end === 'start' ? leg.coords[0] : leg.coords[leg.coords.length - 1];
        set(s => ({
          anchors: s.anchors.map(a => (a.id === snap.anchorId ? { ...a, lon: p[0], lat: p[1] } : a)),
        }));
      })
      .finally(() => inFlight.delete(slot.id));
  }

  // segment en ligne droite, altitudes lues dans le MNT côté client (API IGN en secours)
  async function computeManualLeg(from: LonLat, to: LonLat): Promise<RouteLeg> {
    const distanceM = haversineM(from, to);
    const sampling = Math.min(100, Math.max(2, Math.round(distanceM / 100)));
    const points: LonLat[] = Array.from({ length: sampling }, (_, i) => {
      const t = i / (sampling - 1);
      return [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])];
    });
    const coords = await sampleElevations(points)
      .then(eles => points.map((p, i) => [p[0], p[1], Math.round(eles[i])] as LonLatEle))
      .catch(() => elevationLine(from, to, sampling))
      .catch(() => straightLeg(from, to).coords);
    return { coords, distanceM };
  }

  // route l'itinéraire complet en une seule requête multi-via puis remplace tous les tronçons.
  // ne touche pas aux itinéraires contenant des tronçons manuels ou importés non matchés:
  // le préréglage s'appliquera à leurs prochaines modifications
  async function rerouteWithPreset() {
    const { anchors, legs } = get();
    if (anchors.length < 2 || legs.some(l => l.manual || !l.leg)) return;
    const token = ++rerouteToken;
    const anchorIds = anchors.map(a => a.id).join();
    const route = await computeRoute(anchors.map(lonLat)).catch(() => null);
    if (!route || token !== rerouteToken) return;
    const current = get();
    if (current.anchors.map(a => a.id).join() !== anchorIds) return;
    const split = splitRoute(route, current.anchors.map(lonLat));
    if (!split || split.legs.length !== current.legs.length) return;
    pushHistory();
    set(s => ({
      legs: split.legs.map(leg => ({ id: crypto.randomUUID(), manual: false, leg })),
      anchors: s.anchors.map((a, i) => ({ ...a, lon: split.junctions[i][0], lat: split.junctions[i][1] })),
    }));
  }

  // après un import GPX: une seule requête multi-via par toutes les ancres, puis chaque tronçon
  // dont le routage colle à la trace d'origine adopte la version routée (avec analyse des voies).
  // les tronçons qui divergent (sentier absent d'OSM…) gardent la géométrie importée
  async function matchImportedRoute() {
    const { anchors } = get();
    if (anchors.length < 2) return;
    const anchorIds = anchors.map(a => a.id).join();
    const route = await computeRoute(anchors.map(lonLat)).catch(() => null);
    if (!route) return;
    const current = get();
    if (current.anchors.map(a => a.id).join() !== anchorIds) return;
    const split = splitRoute(route, current.anchors.map(lonLat));
    if (!split || split.legs.length !== current.legs.length) return;

    const adopted = split.legs.map((routed, i) => {
      const imported = current.legs[i].leg;
      return imported && legMatchesImport(routed, imported) ? routed : null;
    });
    if (!adopted.some(Boolean)) return;
    set(s => {
      if (s.legs !== current.legs) return {};
      return {
        legs: s.legs.map((slot, i) =>
          adopted[i] ? { id: crypto.randomUUID(), manual: false, leg: adopted[i] } : slot,
        ),
        // une ancre n'est aimantée sur le réseau que si tous ses tronçons voisins sont adoptés,
        // sinon elle se détacherait de la géométrie importée conservée
        anchors: s.anchors.map((a, i) => {
          const leftAdopted = i === 0 || adopted[i - 1] !== null;
          const rightAdopted = i === s.anchors.length - 1 || adopted[i] !== null;
          if (!leftAdopted || !rightAdopted) return a;
          return { ...a, lon: split.junctions[i][0], lat: split.junctions[i][1] };
        }),
      };
    });
  }

  function pushHistory() {
    set(s => ({
      history: [
        ...s.history.slice(-(HISTORY_LIMIT - 1)),
        { anchors: s.anchors, legs: s.legs, offRoutePoints: s.offRoutePoints },
      ],
      future: [],
    }));
  }

  // pompe de routage du drag: au plus une requête en vol, relancée avec la dernière position (latest-wins)
  async function pumpDragRoute() {
    if (dragBusy || !dragNextPos || !draggingAnchor) return;
    dragBusy = true;
    const { index, p } = dragNextPos;
    dragNextPos = null;
    const { anchors, legs, manualMode } = get();
    const jobs: Promise<void>[] = [];
    for (const legIndex of [index - 1, index]) {
      if (legIndex < 0 || legIndex >= legs.length) continue;
      const from = legIndex === index - 1 ? lonLat(anchors[legIndex]) : p;
      const to = legIndex === index - 1 ? p : lonLat(anchors[legIndex + 1]);
      const promise = manualMode
        ? Promise.resolve(straightLeg(from, to))
        : computeLeg(from, to).catch(() => straightLeg(from, to));
      jobs.push(
        promise.then(leg => {
          if (!draggingAnchor) return;
          set(s => ({ legs: s.legs.map((l, i) => (i === legIndex ? { ...l, id: crypto.randomUUID(), leg } : l)) }));
        }),
      );
    }
    await Promise.all(jobs);
    dragBusy = false;
    pumpDragRoute();
  }

  // relance les tronçons perdus après un undo/redo (réponse arrivée entre-temps sur un autre slot)
  function ensureLegs() {
    const { anchors, legs } = get();
    legs.forEach((slot, i) => {
      if (!slot.leg) launchLeg(slot, lonLat(anchors[i]), lonLat(anchors[i + 1]));
    });
  }

  const draft = loadDraft();

  return {
    lang: detectLang(),
    baseLayerId: DEFAULT_BASE_LAYER,
    overlays: {
      km: true,
      contours: true,
      hillshade: false,
      slopes: false,
      gr: false,
      hidden: false,
      refuges: false,
      terrain3d: false,
    },
    manualMode: false,
    routingPreset: 'balanced' as RoutingPreset,
    wayTypeHighlight: null,
    anchors: draft?.anchors ?? [],
    legs: draft?.legs ?? [],
    offRoutePoints: draft?.offRoutePoints ?? [],
    history: [],
    future: [],
    savedRoutes: loadRoutes(),
    currentRouteId: draft?.currentRouteId ?? null,
    currentRouteName: draft?.currentRouteName ?? '',
    showRoutes: false,
    editing: null,
    hoverPoint: null,
    flyTo: null,
    error: null,

    addAnchor: p => {
      pushHistory();
      const previous = get().anchors.at(-1);
      const anchor = newAnchor(p);
      if (!previous) {
        set(s => ({ anchors: [...s.anchors, anchor] }));
        return;
      }
      const slot = newSlot(get().manualMode);
      set(s => ({ anchors: [...s.anchors, anchor], legs: [...s.legs, slot] }));
      launchLeg(slot, lonLat(previous), p, { anchorId: anchor.id, end: 'end' });
    },

    // insère un checkpoint en découpant la géométrie existante au point le plus proche:
    // le tracé (routé ou importé) est préservé à l'identique, sans recalcul réseau
    insertAnchor: p => {
      const spliced = spliceIntoTrace(get().anchors, get().legs, p, newAnchor(p));
      if (!spliced) return;
      pushHistory();
      set(spliced);
    },

    // clic droit: repère informatif hors tracé (une source, une vue... qu'on veut connaître
    // sans forcément y passer); pour un POI du parcours, on clique sur la trace
    // route reçue par lien de partage: le brouillon en cours reste à un undo de distance
    applySharedRoute: ({ name, preset, anchors, legs, offRoutePoints }) => {
      if (anchors.length === 0 || legs.length !== anchors.length - 1) throw new Error('route partagée invalide');
      pushHistory();
      if (preset && preset !== get().routingPreset) setBrouterPreset(preset);
      const lons = anchors.map(a => a.lon);
      const lats = anchors.map(a => a.lat);
      set({
        anchors,
        legs,
        offRoutePoints,
        routingPreset: preset ?? get().routingPreset,
        currentRouteId: null,
        currentRouteName: name,
        editing: null,
        flyTo:
          anchors.length >= 2
            ? {
                bounds: [
                  [Math.min(...lons), Math.min(...lats)],
                  [Math.max(...lons), Math.max(...lats)],
                ],
              }
            : { center: [anchors[0].lon, anchors[0].lat], zoom: 14 },
      });
      ensureLegs();
    },

    addOffRoutePoint: p => {
      pushHistory();
      const point: OffRoutePoint = { id: crypto.randomUUID(), lon: p[0], lat: p[1], kind: 'autre', name: '' };
      set(s => ({ offRoutePoints: [...s.offRoutePoints, point], editing: point.id }));
      // la configuration initiale dans l'éditeur fait partie de la même action que la création
      editingDirty = true;
    },

    moveOffRoutePoint: (id, p) => {
      pushHistory();
      set(s => ({ offRoutePoints: s.offRoutePoints.map(w => (w.id === id ? { ...w, lon: p[0], lat: p[1] } : w)) }));
    },

    removeOffRoutePoint: id => {
      pushHistory();
      set(s => ({ offRoutePoints: s.offRoutePoints.filter(w => w.id !== id), editing: null }));
    },

    setLang: lang => {
      persistLang(lang);
      set({ lang });
    },

    beginDragAnchor: () => {
      draggingAnchor = true;
      pushHistory();
    },

    // pendant le drag on ne montre jamais de ligne droite: le dernier chemin routé reste affiché
    // jusqu'à l'arrivée du suivant, calculé sur la dernière position connue du curseur
    dragAnchor: (index, p) => {
      dragNextPos = { index, p };
      pumpDragRoute();
    },

    // l'historique du déplacement est poussé par beginDragAnchor au début du drag
    moveAnchor: (index, p) => {
      draggingAnchor = false;
      dragNextPos = null;
      set(s => ({ anchors: s.anchors.map((a, i) => (i === index ? { ...a, lon: p[0], lat: p[1] } : a)) }));
      const { anchors, legs, manualMode } = get();
      const movedId = anchors[index].id;
      for (const legIndex of [index - 1, index]) {
        if (legIndex < 0 || legIndex >= legs.length) continue;
        const slot = newSlot(manualMode);
        set(s => ({ legs: s.legs.map((l, i) => (i === legIndex ? slot : l)) }));
        launchLeg(slot, lonLat(anchors[legIndex]), lonLat(anchors[legIndex + 1]), {
          anchorId: movedId,
          end: legIndex === index - 1 ? 'end' : 'start',
        });
      }
    },

    removeAnchor: id => {
      const { anchors, manualMode } = get();
      const index = anchors.findIndex(a => a.id === id);
      if (index < 0) return;
      pushHistory();
      if (index === 0 || index === anchors.length - 1) {
        set(s => ({
          anchors: index === 0 ? s.anchors.slice(1) : s.anchors.slice(0, -1),
          legs: index === 0 ? s.legs.slice(1) : s.legs.slice(0, -1),
          editing: null,
        }));
        return;
      }
      // point intermédiaire: les deux tronçons voisins fusionnent en un seul recalculé
      const slot = newSlot(manualMode);
      set(s => ({
        anchors: s.anchors.toSpliced(index, 1),
        legs: s.legs.flatMap((l, i) => (i === index - 1 ? [slot] : i === index ? [] : [l])),
        editing: null,
      }));
      launchLeg(slot, lonLat(anchors[index - 1]), lonLat(anchors[index + 1]));
    },

    undo: () => {
      const { history } = get();
      const snapshot = history.at(-1);
      if (!snapshot) return;
      set(s => ({
        history: s.history.slice(0, -1),
        future: [...s.future, { anchors: s.anchors, legs: s.legs, offRoutePoints: s.offRoutePoints }],
        editing: null,
        ...snapshot,
      }));
      ensureLegs();
    },

    redo: () => {
      const { future } = get();
      const snapshot = future.at(-1);
      if (!snapshot) return;
      set(s => ({
        future: s.future.slice(0, -1),
        history: [...s.history, { anchors: s.anchors, legs: s.legs, offRoutePoints: s.offRoutePoints }],
        editing: null,
        ...snapshot,
      }));
      ensureLegs();
    },

    clear: () => {
      pushHistory();
      set({
        anchors: [],
        legs: [],
        offRoutePoints: [],
        hoverPoint: null,
        editing: null,
        currentRouteId: null,
        currentRouteName: '',
      });
    },

    reverse: () => {
      if (get().anchors.length < 2) return;
      pushHistory();
      set(s => ({
        anchors: [...s.anchors].reverse(),
        legs: [...s.legs].reverse().map(l => ({
          ...l,
          id: crypto.randomUUID(),
          leg: l.leg ? { coords: [...l.leg.coords].reverse(), distanceM: l.leg.distanceM } : null,
        })),
      }));
      ensureLegs();
    },

    outAndBack: () => {
      const { anchors, legs } = get();
      const coords = routeCoords(legs);
      if (coords.length < 2) return;
      // sur un parcours déjà fermé (boucle ou aller-retour), retracer le tout à l'envers
      // n'apporte rien et empile des ancres superposées au départ
      if (isClosedRoute(anchors)) return;
      pushHistory();
      const returnLeg: RouteLeg = {
        coords: [...coords].reverse(),
        distanceM: legs.reduce((sum, l) => sum + (l.leg?.distanceM ?? 0), 0),
      };
      set(s => ({
        anchors: [...s.anchors, newAnchor(lonLat(anchors[0]))],
        legs: [...s.legs, { id: crypto.randomUUID(), manual: true, leg: returnLeg }],
      }));
    },

    closeLoop: () => {
      const { anchors, manualMode } = get();
      if (anchors.length < 2) return;
      const last = anchors.at(-1);
      const first = anchors[0];
      if (!last || (last.lon === first.lon && last.lat === first.lat)) return;
      pushHistory();
      const slot = newSlot(manualMode);
      set(s => ({ anchors: [...s.anchors, newAnchor(lonLat(first))], legs: [...s.legs, slot] }));
      launchLeg(slot, lonLat(last), lonLat(first));
    },

    importRoute: (coords, waypoints) => {
      if (coords.length < 2) return;
      pushHistory();
      // la trace importée est découpée en tronçons entre ancres: déplacer une ancre ne recalcule
      // que ses deux voisins, au lieu d'effacer la moitié du GPX
      const cuts = importAnchorIndices(coords);
      // un <wpt> proche de la trace est un POI du parcours (ancre aimantée dessus);
      // éloigné, c'est un repère hors tracé (parking, source à côté du sentier...)
      const poiCuts = new Map<number, { name: string; kind: PointKind }>();
      const offRoutePoints: OffRoutePoint[] = [];
      for (const w of waypoints) {
        let best = 0;
        let bestDist = Number.POSITIVE_INFINITY;
        coords.forEach((c, i) => {
          const d = haversineM([c[0], c[1]], [w.lon, w.lat]);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        });
        if (bestDist > IMPORT_WPT_SNAP_M) {
          offRoutePoints.push({ id: crypto.randomUUID(), lon: w.lon, lat: w.lat, kind: w.kind, name: w.name });
        } else if (!poiCuts.has(best)) {
          poiCuts.set(best, { name: w.name, kind: w.kind });
        }
      }
      const allCuts = [...new Set([...cuts, ...poiCuts.keys()])].sort((a, b) => a - b);
      const lons = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);
      set({
        anchors: allCuts.map(i => {
          const poi = poiCuts.get(i);
          const anchor = newAnchor([coords[i][0], coords[i][1]], poi?.kind);
          return poi ? { ...anchor, name: poi.name } : anchor;
        }),
        legs: allCuts.slice(0, -1).map((from, i) => {
          const legCoords = coords.slice(from, allCuts[i + 1] + 1);
          return {
            id: crypto.randomUUID(),
            manual: true,
            leg: { coords: legCoords, distanceM: pathDistanceM(legCoords) },
          };
        }),
        offRoutePoints,
        currentRouteId: null,
        currentRouteName: '',
        editing: null,
        flyTo: {
          bounds: [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
          ],
        },
      });
      void matchImportedRoute();
    },

    setEditing: editing => {
      editingDirty = false;
      set({ editing });
    },

    // un seul cran d'undo par session d'édition, pas un par frappe clavier
    updateEditingPoint: (kind, name) => {
      const { editing } = get();
      if (!editing) return;
      if (!editingDirty) {
        pushHistory();
        editingDirty = true;
      }
      set(s => ({
        anchors: s.anchors.map(a => (a.id === editing ? { ...a, kind, name } : a)),
        offRoutePoints: s.offRoutePoints.map(w => (w.id === editing ? { ...w, kind, name } : w)),
      }));
    },

    removeEditingPoint: () => {
      const { editing, anchors } = get();
      if (!editing) return;
      if (anchors.some(a => a.id === editing)) get().removeAnchor(editing);
      else get().removeOffRoutePoint(editing);
    },

    saveCurrentRoute: name => {
      const { anchors, legs, offRoutePoints, currentRouteId, savedRoutes } = get();
      const coords = routeCoords(legs);
      if (coords.length < 2) return;
      const route: SavedRoute = {
        id: currentRouteId ?? crypto.randomUUID(),
        name,
        updatedAt: new Date().toISOString(),
        distanceM: routeDistanceM(legs),
        gainM: elevationStats(coords).gainM,
        anchors,
        legs,
        offRoutePoints,
      };
      const routes = [route, ...savedRoutes.filter(r => r.id !== route.id)];
      if (!persistRoutes(routes)) {
        set({ error: 'err_storage' });
        return;
      }
      set({ savedRoutes: routes, currentRouteId: route.id, currentRouteName: name });
    },

    loadRoute: id => {
      const route = get().savedRoutes.find(r => r.id === id);
      if (!route) return;
      pushHistory();
      const coords = routeCoords(route.legs);
      const lons = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);
      set({
        anchors: route.anchors,
        legs: route.legs,
        offRoutePoints: route.offRoutePoints,
        currentRouteId: route.id,
        currentRouteName: route.name,
        editing: null,
        showRoutes: false,
        flyTo:
          coords.length >= 2
            ? {
                bounds: [
                  [Math.min(...lons), Math.min(...lats)],
                  [Math.max(...lons), Math.max(...lats)],
                ],
              }
            : null,
      });
      ensureLegs();
    },

    deleteRoute: id => {
      const routes = get().savedRoutes.filter(r => r.id !== id);
      persistRoutes(routes);
      set(s => ({
        savedRoutes: routes,
        ...(s.currentRouteId === id ? { currentRouteId: null, currentRouteName: '' } : {}),
      }));
    },

    toggleRoutesPanel: () => set(s => ({ showRoutes: !s.showRoutes })),
    retryLegs: () => ensureLegs(),

    focusRoute: () => {
      const coords = routeCoords(get().legs);
      if (coords.length < 2) return;
      const lons = coords.map(c => c[0]);
      const lats = coords.map(c => c[1]);
      set({
        flyTo: {
          bounds: [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
          ],
        },
      });
    },

    setManualMode: manualMode => set({ manualMode }),

    setRoutingPreset: preset => {
      if (get().routingPreset === preset) return;
      setBrouterPreset(preset);
      set({ routingPreset: preset });
      void rerouteWithPreset();
    },

    setWayTypeHighlight: wayTypeHighlight => set({ wayTypeHighlight }),

    setBaseLayerId: baseLayerId => set({ baseLayerId }),
    toggleOverlay: name =>
      set(s => {
        const overlays = { ...s.overlays, [name]: !s.overlays[name] };
        // la 3D sans estompage est illisible: activer le terrain allume aussi le relief
        if (name === 'terrain3d' && overlays.terrain3d) overlays.hillshade = true;
        return { overlays };
      }),
    setHoverPoint: hoverPoint => set({ hoverPoint }),
    setFlyTo: flyTo => set({ flyTo }),
    dismissError: () => set({ error: null }),
  };
});

// brouillon auto: l'itinéraire en cours survit au refresh, sans compte ni serveur
let draftTimer = 0;
usePlanner.subscribe(s => {
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    persistDraft({
      anchors: s.anchors,
      legs: s.legs,
      offRoutePoints: s.offRoutePoints,
      currentRouteId: s.currentRouteId,
      currentRouteName: s.currentRouteName,
    });
  }, 400);
});

// relance les tronçons du brouillon restauré qui n'avaient pas fini de se calculer
setTimeout(() => usePlanner.getState().retryLegs(), 0);

// singleton à état: un hot-reload recréerait un second store (UI sur l'un, carte sur l'autre),
// donc tout changement ici recharge la page entière
if (import.meta.hot) import.meta.hot.accept(() => import.meta.hot?.invalidate());

export function lonLat(anchor: Anchor): LonLat {
  return [anchor.lon, anchor.lat];
}

// ancres d'un GPX importé: les sommets qui portent la forme, plafonnés pour rester manipulables
function importAnchorIndices(coords: LonLatEle[]): number[] {
  let toleranceM = IMPORT_ANCHOR_TOLERANCE_M;
  let indices = simplifyIndices(coords, toleranceM);
  while (indices.length > MAX_IMPORT_ANCHORS) {
    toleranceM *= 2;
    indices = simplifyIndices(coords, toleranceM);
  }
  return indices;
}

// le tronçon routé est adopté si sa longueur et son tracé restent proches de la trace importée
function legMatchesImport(routed: RouteLeg, imported: RouteLeg): boolean {
  if (imported.distanceM <= 0 || imported.coords.length < 2) return false;
  if (Math.abs(routed.distanceM - imported.distanceM) / imported.distanceM > MATCH_MAX_LENGTH_RATIO) return false;
  const step = Math.max(1, Math.floor(routed.coords.length / 40));
  let close = 0;
  let total = 0;
  for (let i = 0; i < routed.coords.length; i += step) {
    total++;
    if (pointToPathDistanceM(routed.coords[i], imported.coords) <= MATCH_MAX_DEVIATION_M) close++;
  }
  return total > 0 && close / total >= MATCH_MIN_FRACTION;
}

// cache par identité du tableau legs: chaque composant appelant routeCoords dans son render
// réutilise la même passe d'aplatissement au lieu de rebalayer toute la trace
const coordsCache = new WeakMap<LegSlot[], LonLatEle[]>();

export function routeCoords(legs: LegSlot[]): LonLatEle[] {
  const cached = coordsCache.get(legs);
  if (cached) return cached;
  const coords = legs.flatMap(l => l.leg?.coords ?? []);
  coordsCache.set(legs, coords);
  return coords;
}

export function routeDistanceM(legs: LegSlot[]): number {
  return legs.reduce((sum, l) => sum + (l.leg?.distanceM ?? 0), 0);
}

export function routePois(anchors: Anchor[]): Anchor[] {
  return anchors.filter(a => a.kind !== 'checkpoint');
}

/** vrai si le parcours revient exactement à son point de départ (boucle ou aller-retour) */
export function isClosedRoute(anchors: Anchor[]): boolean {
  const first = anchors[0];
  const last = anchors.at(-1);
  return anchors.length > 2 && !!first && !!last && first.lon === last.lon && first.lat === last.lat;
}
