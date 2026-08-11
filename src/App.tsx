import { useEffect, useState } from 'react';
import { BottomPanel } from './components/BottomPanel';
import { MapControls } from './components/MapControls';
import { MapView } from './components/MapView';
import { PointEditor } from './components/PointEditor';
import { Sidebar } from './components/Sidebar';
import { StatsCard } from './components/StatsCard';
import { TopBar } from './components/TopBar';
import { useT } from './lib/i18n';
import { usePlanner } from './store';

export default function App() {
  const t = useT();
  const error = usePlanner(s => s.error);
  const [sideOpen, setSideOpen] = useState(true);

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
    // boutons précédent/suivant de la souris = undo/redo, quel que soit le canal par lequel
    // ils arrivent (événement souris direct, ou navigation historique générée par l'OS/driver).
    // Une pile de sentinelles absorbe les navigations back en série; history.go() la recharge
    // (traversée d'entrées existantes: jamais filtrée par Chrome, contrairement à pushState).
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
      // le même clic physique peut émettre l'événement souris ET la navigation: ne pas doubler
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
          {error && (
            <button type="button" className="toast" onClick={() => usePlanner.getState().dismissError()}>
              {t(error)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
