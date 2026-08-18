/**
 * Daily forecast for a stage, from Open-Meteo (open data, no key). The model resolves the
 * elevation itself, so a col at 2900 m gets mountain weather, not the valley's.
 */

import type { LonLat } from './geo';
import { fetchWithTimeout } from './http';

export interface DayForecast {
  /** WMO weather code, folded into an emoji by `weatherEmoji` */
  code: number;
  minC: number;
  maxC: number;
  precipitationMm: number;
  windKmH: number;
}

/** Open-Meteo serves 16 days of forecast; beyond that a date has no answer yet */
export const FORECAST_DAYS = 16;

const API_URL = 'https://api.open-meteo.com/v1/forecast';
const cache = new Map<string, Promise<DayForecast | null>>();

/**
 * Forecast for one place on one day.
 *
 * Args:
 *   point: where the day is walked (a stage midpoint reads well).
 *   date: ISO day, within the forecast horizon.
 *
 * Returns:
 *   The day's forecast, or null when the date is out of range or the API is unreachable.
 */
export function fetchDayForecast(point: LonLat, date: string): Promise<DayForecast | null> {
  if (!withinHorizon(date)) return Promise.resolve(null);
  // a quarter degree (~25 km) per cache slot: weather does not change by the metre
  const key = `${point[0].toFixed(1)},${point[1].toFixed(1)},${date}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = queryDay(point, date).catch(() => {
      cache.delete(key);
      return null;
    });
    cache.set(key, hit);
  }
  return hit;
}

/** rough WMO-code reading, enough to choose between sun, clouds, rain and snow */
export function weatherEmoji(code: number): string {
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 49) return '🌫️';
  if (code <= 59 || (code >= 80 && code <= 82)) return '🌦️';
  if (code <= 69) return '🌧️';
  if (code <= 79 || code === 85 || code === 86) return '🌨️';
  return '⛈️';
}

/** the ISO day `offset` days after `date` */
export function addDays(date: string, offset: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function queryDay(point: LonLat, date: string): Promise<DayForecast | null> {
  const params = new URLSearchParams({
    latitude: point[1].toFixed(3),
    longitude: point[0].toFixed(3),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
    timezone: 'auto',
    start_date: date,
    end_date: date,
  });
  const res = await fetchWithTimeout(`${API_URL}?${params}`);
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const data = await res.json();
  const day = data.daily;
  if (!day || !Number.isFinite(day.temperature_2m_max?.[0])) return null;
  return {
    code: day.weather_code?.[0] ?? 3,
    minC: day.temperature_2m_min[0],
    maxC: day.temperature_2m_max[0],
    precipitationMm: day.precipitation_sum?.[0] ?? 0,
    windKmH: day.wind_speed_10m_max?.[0] ?? 0,
  };
}

function withinHorizon(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const today = new Date().toISOString().slice(0, 10);
  return date >= today && date <= addDays(today, FORECAST_DAYS - 1);
}
