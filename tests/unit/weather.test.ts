import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, fetchDayForecast, weatherEmoji } from '../../src/lib/weather';

const DAILY = {
  daily: {
    time: ['2099-01-01'],
    weather_code: [61],
    temperature_2m_max: [16.5],
    temperature_2m_min: [9.1],
    precipitation_sum: [4.2],
    wind_speed_10m_max: [31],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDayForecast', () => {
  it('reads the day out of the open-meteo answer', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(DAILY)));
    vi.stubGlobal('fetch', fetchMock);
    const today = new Date().toISOString().slice(0, 10);

    const day = await fetchDayForecast([6.77, 44.63], today);
    expect(day).toMatchObject({ code: 61, minC: 9.1, maxC: 16.5, precipitationMm: 4.2, windKmH: 31 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`start_date=${today}`);
    expect(url).toContain('timezone=auto');
  });

  it('answers nothing for a date past the 16-day horizon, without calling anyone', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const today = new Date().toISOString().slice(0, 10);

    expect(await fetchDayForecast([6.77, 44.63], addDays(today, 20))).toBeNull();
    expect(await fetchDayForecast([6.77, 44.63], addDays(today, -3))).toBeNull();
    expect(await fetchDayForecast([6.77, 44.63], 'garbage')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('survives the API being down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    const today = new Date().toISOString().slice(0, 10);
    // a fresh coordinate, so the memoized failure of another test is not what answers
    expect(await fetchDayForecast([3.05, 45.77], today)).toBeNull();
  });
});

describe('helpers', () => {
  it('addDays crosses months and years', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('weatherEmoji folds the wmo codes into the four weathers a hiker cares about', () => {
    expect(weatherEmoji(0)).toBe('☀️');
    expect(weatherEmoji(3)).toBe('☁️');
    expect(weatherEmoji(61)).toBe('🌧️');
    expect(weatherEmoji(75)).toBe('🌨️');
    expect(weatherEmoji(95)).toBe('⛈️');
  });
});
