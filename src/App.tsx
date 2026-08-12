import { useEffect, useState } from 'react';
import { BottomPanel } from './components/BottomPanel';
import { BottomSheet, type SheetStop } from './components/BottomSheet';
import { MapControls } from './components/MapControls';
import { MapView } from './components/MapView';
import { PointEditor } from './components/PointEditor';
import { RouteStats } from './components/RouteStats';
import { Sidebar } from './components/Sidebar';
import { StatsCard } from './components/StatsCard';
import { TopBar } from './components/TopBar';
import { useT } from './lib/i18n';
import { useIsMobile } from './lib/useMediaQuery';
import { usePlanner } from './store';

export default function App() {
  const t = useT();
  const error = usePlanner(s => s.error);
  const isMobile = useIsMobile();
  const [sideOpen, setSideOpen] = useState(true);
  const [sheetStop, setSheetStop] = useState<SheetStop>('peek');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      const planner = usePlanner.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) planner.redo();
        else planner.undo();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        planner.undo();
      }
    }
    // mouse back/forward buttons act as undo/redo, whatever channel they arrive through
    // (direct mouse event, or history navigation synthesized by the OS/driver).
    // A stack of sentinels absorbs back navigations in a row; history.go() refills it
    // (traversing existing entries is never filtered by Chrome, unlike pushState).
    const BACK_STACK = 30;
    let expectedIdx = (history.state as { cairnIdx?: number } | null)?.cairnIdx ?? null;
    if (expectedIdx === null) {
      for (let i = 0; i < BACK_STACK; i++) history.pushState({ cairnIdx: i }, '');
      expectedIdx = BACK_STACK - 1;
    }
    let suppressNext = 0;
    let lastMouseNavAt = 0;

    function act(direction: 'back' | 'forward') {
      const planner = usePlanner.getState();
      if (direction === 'back') planner.undo();
      else planner.redo();
    }
    function onMouseUp(e: MouseEvent) {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      lastMouseNavAt = Date.now();
      act(e.button === 3 ? 'back' : 'forward');
    }
    function onPopState(e: PopStateEvent) {
      const idx = (e.state as { cairnIdx?: number } | null)?.cairnIdx ?? -1;
      if (suppressNext > 0) {
        suppressNext--;
        expectedIdx = idx;
        return;
      }
      const direction = idx < (expectedIdx ?? BACK_STACK - 1) ? 'back' : 'forward';
      expectedIdx = idx;
      // the same physical click can emit both the mouse event and the navigation: do not act twice
      if (Date.now() - lastMouseNavAt > 250) act(direction);
      if (idx <= 0) {
        suppressNext++;
        history.go(BACK_STACK - 1 - idx);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  const toast = error && (
    <button type="button" className="toast" onClick={() => usePlanner.getState().dismissError()}>
      {t(error)}
    </button>
  );

  // on a phone the map keeps the whole screen and everything else lives in a bottom sheet
  if (isMobile) {
    return (
      <div className="app mobile" data-sheet={sheetStop}>
        <TopBar />
        <div className="map-wrap">
          <MapView />
          <MapControls />
          <PointEditor />
          {toast}
        </div>
        <BottomSheet stop={sheetStop} onStopChange={setSheetStop} header={<RouteStats compact />}>
          <BottomPanel />
          <Sidebar />
        </BottomSheet>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        {sideOpen && <Sidebar />}
        <div className="map-wrap">
          <button
            type="button"
            className="side-toggle"
            title={sideOpen ? t('hide_panel') : t('show_panel')}
            onClick={() => setSideOpen(!sideOpen)}
          >
            {sideOpen ? '«' : '»'}
          </button>
          <MapView />
          <MapControls />
          <StatsCard />
          <PointEditor />
          <BottomPanel />
          {toast}
        </div>
      </div>
    </div>
  );
}
