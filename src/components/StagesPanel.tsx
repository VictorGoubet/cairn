import { useEffect, useMemo, useState } from 'react';
import { formatDistance, formatDuration } from '../lib/geo';
import { useT } from '../lib/i18n';
import type { Stage } from '../lib/stages';
import { addDays, type DayForecast, FORECAST_DAYS, fetchDayForecast, weatherEmoji } from '../lib/weather';
import { usePlanner } from '../store';

/**
 * The trek day by day: one row per stage, cut at the camp points, with the day's forecast
 * once a start date is chosen.
 */
export function StagesPanel({ stages }: { stages: Stage[] }) {
  const t = useT();
  const startDate = usePlanner(s => s.startDate);
  const [forecasts, setForecasts] = useState<(DayForecast | null)[]>([]);
  const [open, setOpen] = useState(true);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const horizon = useMemo(() => addDays(today, FORECAST_DAYS - 1), [today]);

  useEffect(() => {
    if (!startDate) {
      setForecasts([]);
      return;
    }
    let stale = false;
    Promise.all(
      stages.map((stage, i) => {
        const mid = stage.coords[Math.floor(stage.coords.length / 2)];
        return mid ? fetchDayForecast([mid[0], mid[1]], addDays(startDate, i)) : Promise.resolve(null);
      }),
    ).then(days => {
      if (!stale) setForecasts(days);
    });
    return () => {
      stale = true;
    };
  }, [stages, startDate]);

  return (
    <div className="stages" data-control="stages">
      <div className="stages-head">
        <button type="button" className="stages-toggle" aria-expanded={open} onClick={() => setOpen(v => !v)}>
          <span className={open ? 'chevron open' : 'chevron'} aria-hidden="true" />
          {t('stages')}
          <span className="stages-count">{stages.length}</span>
        </button>
        <label className="stages-date">
          {t('stage_start')}
          <input
            type="date"
            value={startDate ?? ''}
            min={today}
            onChange={e => usePlanner.getState().setStartDate(e.target.value || null)}
          />
        </label>
      </div>
      {open && (
        <ul className="stages-list">
          {stages.map((stage, i) => {
            const forecast = forecasts[i];
            return (
              <li key={stage.fromAnchor}>
                <span className="stage-day">
                  J{i + 1}
                  {startDate && <small>{shortDate(addDays(startDate, i))}</small>}
                </span>
                <span className="stage-name">{stage.name || (i === stages.length - 1 ? t('end') : t('stage'))}</span>
                <span className="stage-stats">
                  {formatDistance(stage.distanceM)} · +{Math.round(stage.gainM)} m · -{Math.round(stage.lossM)} m ·{' '}
                  {formatDuration(stage.hours)}
                </span>
                {forecast && (
                  <span className="stage-weather" title={`${t('stage_wind')} ${Math.round(forecast.windKmH)} km/h`}>
                    {weatherEmoji(forecast.code)} {Math.round(forecast.minC)}° / {Math.round(forecast.maxC)}°
                    {forecast.precipitationMm >= 1 && ` · ${Math.round(forecast.precipitationMm)} mm`}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && startDate && addDays(startDate, stages.length - 1) > horizon && (
        <p className="side-hint">{t('stage_forecast_horizon')}</p>
      )}
    </div>
  );
}

function shortDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}
