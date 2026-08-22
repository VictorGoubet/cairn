import { create } from 'zustand';
import { DEFAULT_BASE_LAYER } from './config/layers';
import type { BivouacSpot } from './lib/bivouac';
import {
  computeLeg,
  computeRoute,
  isTransient,
  type RouteLeg,
  RoutingError,
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
import { DEFAULT_PROFILE, type HikerProfile } from './lib/hikingTime';
import type { MsgKey } from './lib/i18n';
import { detectLang, type Lang, persistLang } from './lib/lang';
import type { PointKind } from './lib/points';
import { clearProgress } from './lib/routeProgress';
import { nearestOnTrace, spliceIntoTrace } from './lib/routeSplice';
import { loadDraft, loadProfile, loadRoutes, persistDraft, persistProfile, persistRoutes } from './lib/storage';

const HISTORY_LIMIT = 50;
const MAX_IMPORT_ANCHORS = 40;
const IMPORT_ANCHOR_TOLERANCE_M = 25;
// beyond this distance from the trace, an imported <wpt> stays an off-route marker
const IMPORT_WPT_SNAP_M = 100;
// adopting the routing of an imported leg: it must stick to the original trace
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

/** free marker dropped on right click (spring, viewpoint...): informative, no influence on the route */
export interface OffRoutePoint {
  id: string;
  lon: number;
  lat: number;
  kind: PointKind;
  name: string;
}

export interface LegSlot {
  id: string;
  /** how to compute this leg if it still needs computing, no effect on an already frozen geometry (import, out-and-back) */
  manual: boolean;
  leg: RouteLeg | null;
}

type FlyTo = { center: LonLat; zoom: number } | { bounds: [LonLat, LonLat] };

/** dimension and value highlighted on the map when hovering the legends */
export type WayHighlight = { dim: 'category' | 'surface'; value: string };

/** stretch selected on the elevation profile, in meters along the route */
type ProfileSelection = { fromM: number; toM: number };

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

/** route decoded from a share link (see lib/share.ts) */
interface SharedRouteInput {
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
  refuges: boolean;
  offlineZones: boolean;
  terrain3d: boolean;
}

interface PlannerState {
  lang: Lang;
  baseLayerId: string;
  overlays: Overlays;
  manualMode: boolean;
  routingPreset: RoutingPreset;
  wayTypeHighlight: WayHighlight | null;
  profileSelection: ProfileSelection | null;
  /** true while the play view is open, see lib/flyover */
  flyover: boolean;
  /** inside the play view: false = the camera flies, true = manual, the dot follows the profile */
  flyoverPaused: boolean;
  /** true while the map tracks the device position along the route, see lib/follow */
  following: boolean;
  /** pace and load, which drive every duration and calorie the app shows */
  profile: HikerProfile;
  anchors: Anchor[];
  legs: LegSlot[];
  offRoutePoints: OffRoutePoint[];
  history: Snapshot[];
  future: Snapshot[];
  savedRoutes: SavedRoute[];
  currentRouteId: string | null;
  currentRouteName: string;
  /** ISO day the trek starts, driving the per-stage weather; null when undated */
  startDate: string | null;
  showRoutes: boolean;
  /** id of the point (anchor or off-route) being edited in the metadata panel */
  editing: string | null;
  /** index of the leg whose editor is open, chosen from the map or from the sidebar list */
  editingLeg: number | null;
  /** true while an anchor is being dragged: heavy map work waits for the drop */
  dragging: boolean;
  hoverPoint: LonLat | null;
  /** where the last search landed, shown as a pin until it is used or dismissed */
  searchPin: LonLat | null;
  flyTo: FlyTo | null;
  error: MsgKey | null;
  setLang: (lang: Lang) => void;
  addAnchor: (p: LonLat) => void;
  insertAnchor: (p: LonLat, kind?: PointKind) => boolean;
  /** inserts a point at its own coordinates, detouring the route to reach it */
  insertDetour: (p: LonLat, kind?: PointKind) => boolean;
  beginDragAnchor: () => void;
  dragAnchor: (index: number, p: LonLat) => void;
  moveAnchor: (index: number, p: LonLat) => void;
  removeAnchor: (id: string) => void;
  reorderAnchor: (from: number, to: number) => void;
  slideAnchor: (id: string, to: number, p: LonLat) => void;
  routeStraightLegs: () => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  reverse: () => void;
  outAndBack: () => void;
  closeLoop: () => void;
  openLoop: () => void;
  trimRoute: (anchorId: string, keep: 'before' | 'after') => void;
  importRoute: (coords: LonLatEle[], waypoints: { lon: number; lat: number; name: string; kind: PointKind }[]) => void;
  applySharedRoute: (route: SharedRouteInput) => void;
  addOffRoutePoint: (p: LonLat) => void;
  moveOffRoutePoint: (id: string, p: LonLat) => void;
  removeOffRoutePoint: (id: string) => void;
  setEditing: (id: string | null) => void;
  setEditingLeg: (index: number | null) => void;
  setStartDate: (date: string | null) => void;
  /** bivouac suggestions currently on the map, empty until a search runs */
  bivouacSpots: BivouacSpot[];
  setBivouacSpots: (spots: BivouacSpot[]) => void;
  /** bumped when a bundle is downloaded or freed, so the map redraws its zones */
  offlineVersion: number;
  bumpOfflineVersion: () => void;
  updateEditingPoint: (kind: PointKind, name: string) => void;
  removeEditingPoint: () => void;
  saveCurrentRoute: (name: string) => boolean;
  loadRoute: (id: string) => void;
  deleteRoute: (id: string) => void;
  toggleRoutesPanel: () => void;
  retryLegs: () => void;
  focusRoute: () => void;
  setManualMode: (manual: boolean) => void;
  setRoutingPreset: (preset: RoutingPreset) => void;
  setWayTypeHighlight: (highlight: WayHighlight | null) => void;
  setProfileSelection: (selection: ProfileSelection | null) => void;
  toggleFlyover: () => void;
  stopFlyover: () => void;
  setFlyoverPaused: (paused: boolean) => void;
  toggleFollow: () => void;
  stopFollow: () => void;
  setProfile: (profile: HikerProfile) => void;
  setBaseLayerId: (id: string) => void;
  toggleOverlay: (name: keyof Overlays) => void;
  setOverlay: (name: keyof Overlays, value: boolean) => void;
  setHoverPoint: (p: LonLat | null) => void;
  setSearchPin: (p: LonLat | null) => void;
  setFlyTo: (target: FlyTo | null) => void;
  dismissError: () => void;
}

const inFlight = new Set<string>();
let editingDirty = false;
// "latest-wins" drag: a single routing request in flight, always relaunched on the latest position
// dragSession discards the answers of a drag that is over, whatever its leg index became
let dragSession = 0;
let draggingAnchor = false;
let dragBusy = false;
let dragNextPos: { index: number; p: LonLat } | null = null;
// invalidates preset reroutes that have become obsolete
let rerouteToken = 0;

export const usePlanner = create<PlannerState>((set, get) => {
  function newSlot(manual: boolean): LegSlot {
    return { id: crypto.randomUUID(), manual, leg: null };
  }

  function newAnchor(p: LonLat, kind: PointKind = 'checkpoint'): Anchor {
    return { id: crypto.randomUUID(), lon: p[0], lat: p[1], kind, name: '' };
  }

  // each leg has an id: a network response arriving after an undo/clear no longer finds its slot.
  // snap: the router realigns the endpoints onto the nearest trail, the anchor involved is
  // magnetized onto the computed geometry so it never stays floating next to its own trace
  function launchLeg(slot: LegSlot, from: LonLat, to: LonLat, snap?: { anchorId: string; end: 'start' | 'end' }) {
    if (inFlight.has(slot.id)) return;
    inFlight.add(slot.id);
    const promise = slot.manual
      ? computeManualLeg(from, to)
      : computeLeg(from, to).catch((err: unknown) => {
          // the public router kills any computation past four seconds (a 400), so a long leg
          // fails for a reason the hiker can act on: split it. Anything else is the network.
          const busy = err instanceof RoutingError && isTransient(err.status);
          set({ error: busy ? 'err_routing_long' : 'err_routing' });
          return computeManualLeg(from, to);
        });
    promise
      .then(leg => {
        set(s => {
          // stale answer: the slot was replaced by an undo, a clear or a drag meanwhile
          if (!s.legs.some(l => l.id === slot.id)) return {};
          const legs = s.legs.map(l => (l.id === slot.id ? { ...l, leg } : l));
          if (!snap || slot.manual || leg.coords.length === 0) return { legs };
          const p = snap.end === 'start' ? leg.coords[0] : leg.coords[leg.coords.length - 1];
          return {
            legs,
            anchors: s.anchors.map(a => (a.id === snap.anchorId ? { ...a, lon: p[0], lat: p[1] } : a)),
          };
        });
      })
      .finally(() => inFlight.delete(slot.id));
  }

  // straight-line segment, elevations read from the client-side DEM (IGN API as fallback)
  async function computeManualLeg(from: LonLat, to: LonLat): Promise<RouteLeg> {
    const distanceM = haversineM(from, to);
    const sampling = Math.min(100, Math.max(2, Math.round(distanceM / 100)));
    const points: LonLat[] = Array.from({ length: sampling }, (_, i) => {
      const t = i / (sampling - 1);
      return [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])];
    });
    const coords = await sampleElevations(points)
      .then(eles => {
        // a throttled tile server answers zeros point by point instead of throwing: a flat-zero
        // profile in the mountains is a failure wearing a success suit
        if (eles.every(e => Math.abs(e) < 0.5)) throw new Error('dem returned no relief');
        return points.map((p, i) => [p[0], p[1], Math.round(eles[i])] as LonLatEle);
      })
      .catch(() => elevationLine(from, to, sampling))
      .catch(() => straightLeg(from, to).coords);
    return { coords, distanceM };
  }

  // routes the full itinerary in a single multi-via request, then replaces every leg.
  // leaves alone itineraries containing manual or unmatched imported legs:
  // the preset will apply to their next edits
  async function rerouteWithPreset() {
    const { anchors, legs } = get();
    if (anchors.length < 2 || legs.some(l => l.manual || !l.leg)) return;
    const token = ++rerouteToken;
    const fingerprint = routeFingerprint(anchors);
    const route = await computeRoute(anchors.map(lonLat)).catch(() => null);
    if (!route || token !== rerouteToken) return;
    const current = get();
    if (routeFingerprint(current.anchors) !== fingerprint) return;
    const split = splitRoute(route, current.anchors.map(lonLat));
    if (!split || split.legs.length !== current.legs.length) return;
    pushHistory();
    set(s => ({
      legs: split.legs.map(leg => ({ id: crypto.randomUUID(), manual: false, leg })),
      anchors: s.anchors.map((a, i) => ({ ...a, lon: split.junctions[i][0], lat: split.junctions[i][1] })),
    }));
  }

  // after a GPX import: a single multi-via request through all anchors, then every leg
  // whose routing sticks to the original trace adopts the routed version (with way analysis).
  // legs that diverge (trail missing from OSM...) keep the imported geometry
  async function matchImportedRoute() {
    const { anchors } = get();
    if (anchors.length < 2) return;
    const fingerprint = routeFingerprint(anchors);
    const route = await computeRoute(anchors.map(lonLat)).catch(() => null);
    if (!route) return;
    const current = get();
    if (routeFingerprint(current.anchors) !== fingerprint) return;
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
        // an anchor is magnetized onto the network only if all its neighboring legs are adopted,
        // otherwise it would detach from the imported geometry we keep
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

  // drag routing pump: at most one request in flight, relaunched with the latest position (latest-wins)
  async function pumpDragRoute() {
    if (dragBusy || !dragNextPos || !draggingAnchor) return;
    dragBusy = true;
    const session = dragSession;
    const { index, p } = dragNextPos;
    dragNextPos = null;
    const { anchors, legs, manualMode } = get();
    const jobs: Promise<void>[] = [];
    for (const legIndex of [index - 1, index]) {
      if (legIndex < 0 || legIndex >= legs.length) continue;
      const slotId = legs[legIndex].id;
      const from = legIndex === index - 1 ? lonLat(anchors[legIndex]) : p;
      const to = legIndex === index - 1 ? p : lonLat(anchors[legIndex + 1]);
      const promise = manualMode
        ? Promise.resolve(straightLeg(from, to))
        : computeLeg(from, to).catch(() => straightLeg(from, to));
      jobs.push(
        promise.then(leg => {
          // the drag ended or another one started: this answer belongs to nobody.
          // writing by slot id, never by index, which says nothing about identity
          if (session !== dragSession) return;
          set(s => ({ legs: s.legs.map(l => (l.id === slotId ? { ...l, leg } : l)) }));
        }),
      );
    }
    await Promise.all(jobs);
    dragBusy = false;
    pumpDragRoute();
  }

  // relaunches the legs lost after an undo/redo (response arrived meanwhile on another slot)
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
      contours: false,
      hillshade: false,
      slopes: false,
      gr: false,
      refuges: false,
      offlineZones: false,
      terrain3d: false,
    },
    manualMode: false,
    routingPreset: 'balanced' as RoutingPreset,
    wayTypeHighlight: null,
    profileSelection: null,
    flyover: false,
    flyoverPaused: false,
    following: false,
    profile: loadProfile() ?? DEFAULT_PROFILE,
    anchors: draft?.anchors ?? [],
    legs: draft?.legs ?? [],
    offRoutePoints: draft?.offRoutePoints ?? [],
    history: [],
    future: [],
    savedRoutes: loadRoutes(),
    currentRouteId: draft?.currentRouteId ?? null,
    currentRouteName: draft?.currentRouteName ?? '',
    startDate: draft?.startDate ?? null,
    offlineVersion: 0,
    bivouacSpots: [],
    showRoutes: false,
    dragging: false,
    editing: null,
    editingLeg: null,
    hoverPoint: null,
    searchPin: null,
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

    // inserts a checkpoint by splitting the existing geometry at the nearest point:
    // the trace (routed or imported) is preserved identically, with no network recomputation
    insertAnchor: (p, kind) => {
      const spliced = spliceIntoTrace(get().anchors, get().legs, p, newAnchor(p, kind));
      if (!spliced) return false;
      pushHistory();
      set(spliced);
      return true;
    },

    // a bivouac sits off the path on purpose: splicing would project it back onto the trace and
    // lose the very spot that was picked, so the route takes the detour instead
    insertDetour: (p, kind) => {
      const { anchors, legs, manualMode } = get();
      const hit = nearestOnTrace(legs, p);
      if (!hit || anchors.length < 2) return false;
      const index = hit.legIndex;
      const anchor = newAnchor(p, kind);
      const before = newSlot(manualMode);
      const after = newSlot(manualMode);
      pushHistory();
      set(s => ({
        anchors: s.anchors.toSpliced(index + 1, 0, anchor),
        legs: s.legs.toSpliced(index, 1, before, after),
      }));
      launchLeg(before, lonLat(anchors[index]), p);
      launchLeg(after, p, lonLat(anchors[index + 1]));
      return true;
    },

    // right click: informative off-route marker (a spring, a viewpoint... we want to know about
    // without necessarily passing by), for a POI on the route we click on the trace
    // route received through a share link: the current draft stays one undo away
    applySharedRoute: ({ name, preset, anchors, legs, offRoutePoints }) => {
      if (anchors.length === 0 || legs.length !== anchors.length - 1) throw new Error('invalid shared route');
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
      const point: OffRoutePoint = { id: crypto.randomUUID(), lon: p[0], lat: p[1], kind: 'other', name: '' };
      set(s => ({ offRoutePoints: [...s.offRoutePoints, point], editing: point.id }));
      // the initial setup in the editor is part of the same action as the creation
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
      dragSession++;
      draggingAnchor = true;
      set({ dragging: true });
      pushHistory();
    },

    // during the drag we never show a straight line: the last routed path stays displayed
    // until the next one arrives, computed on the last known cursor position
    dragAnchor: (index, p) => {
      dragNextPos = { index, p };
      pumpDragRoute();
    },

    // the move history is pushed by beginDragAnchor at the start of the drag
    moveAnchor: (index, p) => {
      dragSession++;
      draggingAnchor = false;
      set({ dragging: false });
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
      // intermediate point: the two neighboring legs merge into a single recomputed one
      const slot = newSlot(manualMode);
      set(s => ({
        anchors: s.anchors.toSpliced(index, 1),
        legs: s.legs.flatMap((l, i) => (i === index - 1 ? [slot] : i === index ? [] : [l])),
        editing: null,
      }));
      launchLeg(slot, lonLat(anchors[index - 1]), lonLat(anchors[index + 1]));
    },

    // swapping two points changes the shape of the route: every leg between them, plus the
    // one before and after, is recomputed. Frozen legs (import, manual) keep their geometry.
    // an imported trace whose points are joined by beelines (a list of geocaches, a hand-drawn
    // sketch) becomes a walkable itinerary: every straight leg is sent to the router
    routeStraightLegs: () => {
      const { anchors, legs } = get();
      if (anchors.length < 2 || !legs.some(l => l.manual)) return;
      pushHistory();
      set(s => ({ legs: s.legs.map(slot => (slot.manual ? newSlot(false) : slot)) }));
      ensureLegs();
    },

    slideAnchor: (id, to, p) => {
      const { anchors, manualMode } = get();
      const from = anchors.findIndex(a => a.id === id);
      if (from < 0 || to < 0 || to >= anchors.length) return;
      pushHistory();
      const moved = { ...anchors[from], lon: p[0], lat: p[1] };
      const nextAnchors = anchors.toSpliced(from, 1).toSpliced(to, 0, moved);
      const firstLeg = Math.max(0, Math.min(from, to) - 1);
      const lastLeg = Math.min(nextAnchors.length - 2, Math.max(from, to));
      const staleLegs = get().legs.map((slot, i) =>
        i >= firstLeg && i <= lastLeg && !slot.manual ? newSlot(manualMode) : slot,
      );
      set({ anchors: nextAnchors, legs: staleLegs });
      ensureLegs();
    },

    reorderAnchor: (from, to) => {
      const { anchors } = get();
      if (from === to || from < 0 || to < 0 || from >= anchors.length || to >= anchors.length) return;
      pushHistory();
      const moved = anchors[from];
      const nextAnchors = anchors.toSpliced(from, 1).toSpliced(to, 0, moved);
      const firstLeg = Math.max(0, Math.min(from, to) - 1);
      const lastLeg = Math.min(nextAnchors.length - 2, Math.max(from, to));
      const staleLegs = get().legs.map((slot, i) =>
        i >= firstLeg && i <= lastLeg && !slot.manual ? newSlot(get().manualMode) : slot,
      );
      set({ anchors: nextAnchors, legs: staleLegs, flyover: false });
      ensureLegs();
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
        profileSelection: null,
        flyover: false,
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
      // on an already closed route (loop or out-and-back), retracing everything backwards
      // brings nothing and stacks overlapping anchors at the start
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

    // undoing a loop: the closing leg goes, and with it the duplicate of the start that closed
    // it. The real start and the previous finish both stay, which is the whole point
    openLoop: () => {
      const { anchors } = get();
      if (!isClosedRoute(anchors)) return;
      pushHistory();
      set(s => ({ anchors: s.anchors.slice(0, -1), legs: s.legs.slice(0, -1), editing: null }));
    },

    // cutting at a point rather than punching a hole: a leg removed from the middle would leave
    // two disjoint itineraries, which a single-route model cannot hold. Trimming one side keeps
    // a walkable line, and undo brings the rest back.
    trimRoute: (anchorId, keep) => {
      const { anchors } = get();
      const index = anchors.findIndex(a => a.id === anchorId);
      if (index <= 0 || index >= anchors.length - 1) return;
      pushHistory();
      set(s => ({
        anchors: keep === 'before' ? s.anchors.slice(0, index + 1) : s.anchors.slice(index),
        legs: keep === 'before' ? s.legs.slice(0, index) : s.legs.slice(index),
        editing: null,
        editingLeg: null,
        profileSelection: null,
      }));
    },

    importRoute: (coords, waypoints) => {
      // a geocaching export carries waypoints and no track: the markers land on the map and the
      // current itinerary is left alone, which is what makes them usable as things to route by
      if (coords.length < 2) {
        if (waypoints.length === 0) return;
        pushHistory();
        set(s => ({
          offRoutePoints: [
            ...s.offRoutePoints,
            ...waypoints.map(w => ({ id: crypto.randomUUID(), lon: w.lon, lat: w.lat, kind: w.kind, name: w.name })),
          ],
          editing: null,
          flyTo: {
            bounds: [
              [Math.min(...waypoints.map(w => w.lon)), Math.min(...waypoints.map(w => w.lat))],
              [Math.max(...waypoints.map(w => w.lon)), Math.max(...waypoints.map(w => w.lat))],
            ],
          },
        }));
        return;
      }
      pushHistory();
      // the imported trace is split into legs between anchors: moving an anchor only recomputes
      // its two neighbors, instead of erasing half the GPX
      const cuts = importAnchorIndices(coords);
      // a <wpt> close to the trace is a POI on the route (anchor magnetized onto it),
      // far away, it is an off-route marker (parking, spring next to the trail...)
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
      // one editor at a time: two panels stacked over the map hide the thing being edited
      set({ editing, editingLeg: null });
    },

    setEditingLeg: index => {
      set({ editingLeg: index, editing: null });
    },

    setStartDate: startDate => {
      set({ startDate });
    },

    bumpOfflineVersion: () => set(s => ({ offlineVersion: s.offlineVersion + 1 })),

    setBivouacSpots: bivouacSpots => set({ bivouacSpots }),

    // a single undo step per editing session, not one per keystroke
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
      if (coords.length < 2) return false;
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
        return false;
      }
      set({ savedRoutes: routes, currentRouteId: route.id, currentRouteName: name });
      return true;
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
    setProfileSelection: profileSelection => set({ profileSelection }),
    // the two playbacks both drive the camera: opening one closes the other
    toggleFlyover: () =>
      set(s => ({ flyover: !s.flyover && routeCoords(s.legs).length >= 2, flyoverPaused: false, following: false })),
    stopFlyover: () => {
      clearProgress();
      set({ flyover: false, flyoverPaused: false });
    },
    toggleFollow: () => set(s => ({ following: !s.following && routeCoords(s.legs).length >= 2, flyover: false })),
    stopFollow: () => {
      clearProgress();
      set({ following: false });
    },

    setProfile: profile => {
      persistProfile(profile);
      set({ profile });
    },
    setFlyoverPaused: flyoverPaused => set({ flyoverPaused }),

    setBaseLayerId: baseLayerId => set({ baseLayerId }),
    toggleOverlay: name => get().setOverlay(name, !get().overlays[name]),

    setOverlay: (name, value) =>
      set(s => {
        const overlays = { ...s.overlays, [name]: value };
        // 3D without hillshading is unreadable: turning on the terrain also turns on the relief
        if (name === 'terrain3d' && overlays.terrain3d) overlays.hillshade = true;
        return { overlays };
      }),
    setHoverPoint: hoverPoint => set({ hoverPoint }),
    setSearchPin: searchPin => set({ searchPin }),
    setFlyTo: flyTo => set({ flyTo }),
    dismissError: () => set({ error: null }),
  };
});

// auto draft: the current itinerary survives a refresh, with no account and no server
const DRAFT_DEBOUNCE_MS = 400;
let draftTimer = 0;

function writeDraft() {
  window.clearTimeout(draftTimer);
  draftTimer = 0;
  const s = usePlanner.getState();
  const written = persistDraft({
    anchors: s.anchors,
    legs: s.legs,
    offRoutePoints: s.offRoutePoints,
    currentRouteId: s.currentRouteId,
    currentRouteName: s.currentRouteName,
    startDate: s.startDate,
  });
  // silence here would let a full quota eat the work; the guard keeps the error from
  // re-triggering this very subscriber in a loop
  if (!written && s.error !== 'err_storage') usePlanner.setState({ error: 'err_storage' });
}

usePlanner.subscribe(() => {
  window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(writeDraft, DRAFT_DEBOUNCE_MS);
});

// the debounce restarts on every change, so a tab closing or reloading right after an edit
// would drop it: flush while the page is still alive
window.addEventListener('pagehide', writeDraft);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') writeDraft();
});

// relaunches the restored draft's legs that had not finished computing
setTimeout(() => usePlanner.getState().retryLegs(), 0);

// stateful singleton: a hot reload would recreate a second store (UI on one, map on the other),
// so any change here reloads the whole page
if (import.meta.hot) import.meta.hot.accept(() => import.meta.hot?.invalidate());

function lonLat(anchor: Anchor): LonLat {
  return [anchor.lon, anchor.lat];
}

/** anchors identity plus position: a drag keeps the ids, so ids alone cannot prove freshness */
function routeFingerprint(anchors: Anchor[]): string {
  return anchors.map(a => `${a.id}:${a.lon},${a.lat}`).join('|');
}

// anchors of an imported GPX: the vertices that carry the shape, capped to stay manageable
function importAnchorIndices(coords: LonLatEle[]): number[] {
  let toleranceM = IMPORT_ANCHOR_TOLERANCE_M;
  let indices = simplifyIndices(coords, toleranceM);
  while (indices.length > MAX_IMPORT_ANCHORS) {
    toleranceM *= 2;
    indices = simplifyIndices(coords, toleranceM);
  }
  return indices;
}

// the routed leg is adopted if its length and its path stay close to the imported trace
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

// cache keyed by the identity of the legs array: every component calling routeCoords in its render
// reuses the same flattening pass instead of rescanning the whole trace
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

/** true if the route comes back exactly to its starting point (loop or out-and-back) */
export function isClosedRoute(anchors: Anchor[]): boolean {
  const first = anchors[0];
  const last = anchors.at(-1);
  return anchors.length > 2 && !!first && !!last && first.lon === last.lon && first.lat === last.lat;
}
