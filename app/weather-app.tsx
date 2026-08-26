import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

type Location = { name: string; country: string; latitude: number; longitude: number };
type Series = (number | null)[];
type Hourly = { time: string[] } & Record<string, Series | string[]>;
type Forecast = { hourly: Hourly; hourly_units?: Record<string, string>; utc_offset_seconds?: number };
type ModelKey = 'ECMWF' | 'GFS' | 'ICON' | 'AIFS';
type ActiveModel = ModelKey | 'MEAN';
type ViewKey = 'Forecast' | 'Compare' | 'Map' | 'Saved';
type DataSource = 'live' | 'cache' | 'none';
type CachePayload = { forecasts: Partial<Record<ModelKey, Forecast>>; marine: Forecast | null; extended: Forecast | null; savedAt: number };

const MODEL_IDS: Record<ModelKey, string> = {
  ECMWF: 'ecmwf_ifs', GFS: 'gfs_seamless', ICON: 'icon_global', AIFS: 'ecmwf_aifs025_single',
};
const MODEL_KEYS = Object.keys(MODEL_IDS) as ModelKey[];
const MODEL_META: Record<ModelKey, { provider: string; resolution: string }> = {
  ECMWF: { provider: 'European Centre', resolution: '9 km' },
  GFS: { provider: 'NOAA', resolution: '11–25 km' },
  ICON: { provider: 'DWD', resolution: '11 km' },
  AIFS: { provider: 'ECMWF AI', resolution: '25 km' },
};
const DEFAULT_LOCATION: Location = { name: 'Haifa', country: 'Israel', latitude: 32.794, longitude: 34.9896 };
const WEATHER_VARS = 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cape';
const LONG_RANGE_VARS = 'temperature_2m,temperature_2m_spread,relative_humidity_2m,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_speed_10m_spread,wind_direction_10m,wind_gusts_10m';
const MARINE_VARS = 'wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,wind_wave_height,wind_wave_period,ocean_current_velocity,ocean_current_direction,sea_level_height_msl';

const SPREAD_SUFFIX = '__spread';
const COUNT_SUFFIX = '__models';
const CONSENSUS_KEYS = ['temperature_2m', 'relative_humidity_2m', 'precipitation_probability', 'precipitation', 'cloud_cover', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'cape'];
// Bearings cannot be averaged arithmetically: the mean of 350 and 10 is 180,
// which points the opposite way. They are averaged as unit vectors instead.
const CIRCULAR_KEYS = new Set(['wind_direction_10m']);
const MARINE_KEYS = MARINE_VARS.split(',');

const CACHE_PREFIX = 'weatherdeck:cache:';
const FAVORITES_KEY = 'weatherdeck:favorites';
const WIND_ALERT_KEY = 'weatherdeck:wind-alert';
const REFRESH_MS = 30 * 60 * 1000;
// Open-Meteo's free tier is rate limited and every load costs six requests, so
// incidental refreshes (window focus) are throttled to this interval.
const MIN_REFRESH_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const NO_RESULTS: Location[] = [];

/* ---------- reading forecast values ---------- */

// Open-Meteo pads every series to the requested length and fills the hours a
// model does not actually cover with null, so a present key proves nothing.
function reading(data: Forecast | null | undefined, key: string, index: number): number | null {
  const raw = (data?.hourly?.[key] as Series | undefined)?.[index];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}
function hasSeries(data: Forecast | null | undefined, key: string) {
  const series = data?.hourly?.[key] as Series | undefined;
  return Array.isArray(series) && series.some(value => typeof value === 'number' && Number.isFinite(value));
}
function indexesForDate(data: Forecast | null, date?: string) {
  if (!date) return [];
  return (data?.hourly?.time || []).map((time, index) => (time.startsWith(date) ? index : -1)).filter(index => index >= 0);
}
function coversDate(data: Forecast | null, date: string | undefined, key = 'temperature_2m') {
  if (!date || !data) return false;
  return indexesForDate(data, date).some(index => reading(data, key, index) !== null);
}
function maximumReading(data: Forecast | null, key: string, indexes: number[]) {
  let bestValue = Number.NEGATIVE_INFINITY;
  let bestIndex = -1;
  for (const index of indexes) {
    const value = reading(data, key, index);
    if (value !== null && value > bestValue) { bestValue = value; bestIndex = index; }
  }
  return bestIndex >= 0 ? { value: bestValue, index: bestIndex } : null;
}
function hasVisibleData(data: Forecast | null, key: string, indexes: number[]) {
  return indexes.some(index => reading(data, key, index) !== null);
}
// The wave models run on their own, shorter axis. Rather than a second screen,
// their series are remapped onto the weather axis by timestamp so one table can
// carry the whole forecast for a day.
function withMarine(base: Forecast | null, marine: Forecast | null): Forecast | null {
  if (!base) return null;
  if (!marine?.hourly?.time?.length) return base;
  const positions = new Map<string, number>();
  marine.hourly.time.forEach((time, index) => positions.set(time, index));
  const hourly: Record<string, Series | string[]> = { ...base.hourly };
  for (const key of MARINE_KEYS) {
    hourly[key] = base.hourly.time.map(time => {
      const index = positions.get(time);
      return index === undefined ? null : reading(marine, key, index);
    });
  }
  return { ...base, hourly: hourly as Hourly };
}
function stepIndexes(data: Forecast | null, start: number, step: number, count: number) {
  const length = data?.hourly?.time?.length ?? 0;
  const indexes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const index = start + i * step;
    if (index < length) indexes.push(index);
  }
  return indexes;
}

/* ---------- time ---------- */

// timezone=auto returns naive local timestamps for the *forecast location*, so
// they must be compared against that location's clock, not the device's.
function toUtcMs(time: string) { return Date.parse(`${time}Z`); }
function nowIndexFor(data: Forecast | null) {
  const times = data?.hourly?.time || [];
  if (!times.length) return 0;
  const target = Date.now() + (data?.utc_offset_seconds ?? 0) * 1000;
  const index = times.findIndex(time => toUtcMs(time) >= target);
  return index < 0 ? times.length - 1 : index;
}
function localDateAt(data: Forecast | null) {
  return new Date(Date.now() + (data?.utc_offset_seconds ?? 0) * 1000).toISOString().slice(0, 10);
}
function formatHour(iso?: string) { return iso?.slice(11, 16) || '--:--'; }
function clockLabel(ms: number) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
// Date-only ISO strings parse as UTC midnight, which renders as the previous day
// for anyone west of Greenwich — build the date in local time instead.
function dayLabel(iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  return {
    dow: date.toLocaleDateString('en-US', { weekday: 'short' }),
    date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  };
}

/* ---------- formatting ---------- */

function fixed(value: number | null, digits: number) { return value === null ? '—' : value.toFixed(digits); }
function rounded(value: number | null) { return value === null ? '—' : String(Math.round(value)); }
function cardinal(deg: number | null) {
  if (deg === null) return '—';
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return labels[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
function weatherLabel(cloud: number | null, rain: number | null) {
  if (cloud === null && rain === null) return 'No current reading';
  if (rain !== null && rain > 2) return 'Rain';
  if (rain !== null && rain > 0) return 'Light rain';
  if (cloud === null) return 'Conditions unavailable';
  if (cloud > 75) return 'Overcast';
  if (cloud > 35) return 'Partly cloudy';
  return 'Clear';
}

/* ---------- storage (never allowed to break a render) ---------- */

function readStorage(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function writeStorage(key: string, value: string) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
function storageKeys() {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }
  } catch { /* storage unavailable */ }
  return keys;
}
function locationId(location: Location) { return `${location.latitude.toFixed(4)}|${location.longitude.toFixed(4)}`; }
function cacheKey(location: Location) { return `${CACHE_PREFIX}${location.latitude.toFixed(2)},${location.longitude.toFixed(2)}`; }

// A payload is hundreds of kilobytes, so quota errors are expected. Caching is
// best effort and must stay silent: the fresh data is already on screen.
function writeCache(location: Location, payload: CachePayload) {
  const key = cacheKey(location);
  const json = JSON.stringify(payload);
  if (writeStorage(key, json)) return;
  storageKeys()
    .filter(other => other.startsWith(CACHE_PREFIX) && other !== key)
    .forEach(other => { try { localStorage.removeItem(other); } catch { /* storage unavailable */ } });
  writeStorage(key, json);
}
function readCache(location: Location): CachePayload | null {
  const raw = readStorage(cacheKey(location));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachePayload | null;
    return parsed && typeof parsed === 'object' && parsed.forecasts ? parsed : null;
  } catch { return null; }
}
function isLocation(value: unknown): value is Location {
  const location = value as Location | null;
  return !!location && typeof location.name === 'string' && typeof location.country === 'string'
    && Number.isFinite(location.latitude) && Number.isFinite(location.longitude);
}
function loadFavorites(): Location[] {
  const raw = readStorage(FAVORITES_KEY);
  if (!raw) return [DEFAULT_LOCATION];
  try {
    const parsed: unknown = JSON.parse(raw);
    const clean = Array.isArray(parsed) ? parsed.filter(isLocation) : [];
    return clean.length ? clean : [DEFAULT_LOCATION];
  } catch { return [DEFAULT_LOCATION]; }
}
function loadWindAlert() {
  const value = Number(readStorage(WIND_ALERT_KEY));
  return Number.isFinite(value) && value >= 5 && value <= 40 ? value : 15;
}

// Three-hourly slots covering one day, starting at the current hour when that
// day is today at the forecast location.
function daySlots(data: Forecast | null, date: string | undefined, nowIndex: number) {
  if (!date) return [];
  const all = indexesForDate(data, date);
  const fromNow = date === localDateAt(data) ? all.filter(index => index >= nowIndex) : all;
  const usable = fromNow.length ? fromNow : all;
  return usable.filter((_, i) => i % 3 === 0).slice(0, 8);
}

/**
 * Averages the operational models onto a single time axis, hour by hour.
 *
 * Only the models that actually publish a value at a given hour contribute, so
 * the mean silently narrows as the shorter-range models drop out. That would be
 * misleading on its own, so every variable also carries how many models went
 * into it and how far apart they were: a "mean" of one model is not a
 * consensus, and the table says so.
 */
function buildConsensus(forecasts: Partial<Record<ModelKey, Forecast>>) {
  const members = MODEL_KEYS
    .map(key => forecasts[key])
    .filter((forecast): forecast is Forecast => Boolean(forecast?.hourly?.time?.length));
  if (members.length < 2) return null;

  const axis = members.reduce((longest, forecast) => (forecast.hourly.time.length > longest.hourly.time.length ? forecast : longest), members[0]);
  const times = axis.hourly.time;
  // Aligned by timestamp rather than by position: the models agree on their
  // axis today, but nothing in the API guarantees they always will.
  const lookups = members.map(member => {
    const positions = new Map<string, number>();
    member.hourly.time.forEach((time, index) => positions.set(time, index));
    return { member, positions };
  });

  const hourly: Record<string, Series | string[]> = { time: times };
  for (const key of CONSENSUS_KEYS) {
    const mean: Series = [];
    const count: Series = [];
    const spread: Series = [];
    const circular = CIRCULAR_KEYS.has(key);
    for (const time of times) {
      const values: number[] = [];
      for (const entry of lookups) {
        const index = entry.positions.get(time);
        if (index === undefined) continue;
        const value = reading(entry.member, key, index);
        if (value !== null) values.push(value);
      }
      if (!values.length) { mean.push(null); count.push(null); spread.push(null); continue; }
      count.push(values.length);
      if (circular) {
        const x = values.reduce((sum, value) => sum + Math.cos((value * Math.PI) / 180), 0);
        const y = values.reduce((sum, value) => sum + Math.sin((value * Math.PI) / 180), 0);
        mean.push(x === 0 && y === 0 ? null : (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360);
        spread.push(null);
      } else {
        mean.push(values.reduce((sum, value) => sum + value, 0) / values.length);
        spread.push(values.length > 1 ? Math.max(...values) - Math.min(...values) : null);
      }
    }
    hourly[key] = mean;
    hourly[key + COUNT_SUFFIX] = count;
    hourly[key + SPREAD_SUFFIX] = spread;
  }
  return { hourly: hourly as Hourly, utc_offset_seconds: axis.utc_offset_seconds, members: members.length };
}

// Kept out of the component so the memo around it stays a single call the
// React Compiler can preserve.
function findWindAlert(data: Forecast | null, from: number, threshold: number, key: string) {
  const times = data?.hourly?.time || [];
  for (let index = from; index < Math.min(times.length, from + 24); index += 1) {
    const value = reading(data, key, index);
    if (value !== null && value >= threshold) return { index, value, time: times[index] };
  }
  return null;
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, { signal });
    return response.ok ? (await response.json()) as T : null;
  } catch { return null; }
}

/* ---------- app ---------- */

export default function WeatherApp() {
  const [location, setLocation] = useState<Location>(DEFAULT_LOCATION);
  const [activeModel, setActiveModel] = useState<ActiveModel>('ECMWF');
  const [activeView, setActiveView] = useState<ViewKey>('Forecast');
  const [forecasts, setForecasts] = useState<Partial<Record<ModelKey, Forecast>>>({});
  const [extended, setExtended] = useState<Forecast | null>(null);
  const [marine, setMarine] = useState<Forecast | null>(null);
  const [busy, setBusy] = useState(true);
  const [source, setSource] = useState<DataSource>('none');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Location[]>(NO_RESULTS);
  const [favorites, setFavorites] = useState<Location[]>(loadFavorites);
  const [windAlert, setWindAlert] = useState(loadWindAlert);
  const [notifyState, setNotifyState] = useState<string>(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
  const [gpsError, setGpsError] = useState('');
  const [selectedDay, setSelectedDay] = useState(0);
  const [now, setNow] = useState(0);

  const searchInput = useRef<HTMLInputElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const lastLoadAt = useRef(0);
  const notified = useRef('');

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 30 * 1000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
  }, []);

  useEffect(() => {
    if (import.meta.env.PROD) navigator.serviceWorker?.register('/sw.js').catch(() => undefined);
  }, []);

  const load = useCallback(async (signal: AbortSignal) => {
    setBusy(true);
    const base = `latitude=${location.latitude}&longitude=${location.longitude}&hourly=${WEATHER_VARS}&forecast_days=16&timezone=auto&wind_speed_unit=kn`;
    const [models, nextMarine, nextExtended] = await Promise.all([
      Promise.all(MODEL_KEYS.map(key => fetchJson<Forecast>(`https://api.open-meteo.com/v1/forecast?${base}&models=${MODEL_IDS[key]}`, signal))),
      fetchJson<Forecast>(`https://marine-api.open-meteo.com/v1/marine?latitude=${location.latitude}&longitude=${location.longitude}&hourly=${MARINE_VARS}&forecast_days=10&timezone=auto`, signal),
      fetchJson<Forecast>(`https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${location.latitude}&longitude=${location.longitude}&hourly=${LONG_RANGE_VARS}&forecast_days=21&timezone=auto&wind_speed_unit=kn&models=ncep_gefs05_ensemble_mean`, signal),
    ]);
    if (signal.aborted) return;

    const next: Partial<Record<ModelKey, Forecast>> = {};
    MODEL_KEYS.forEach((key, i) => {
      const forecast = models[i];
      if (forecast?.hourly?.time?.length) next[key] = forecast;
    });

    if (Object.keys(next).length) {
      const savedAt = Date.now();
      setForecasts(next); setMarine(nextMarine); setExtended(nextExtended);
      setUpdatedAt(savedAt); setSource('live'); setBusy(false);
      writeCache(location, { forecasts: next, marine: nextMarine, extended: nextExtended, savedAt });
      return;
    }

    const cached = readCache(location);
    if (cached && Object.keys(cached.forecasts).length) {
      setForecasts(cached.forecasts); setMarine(cached.marine ?? null); setExtended(cached.extended ?? null);
      setUpdatedAt(cached.savedAt ?? null); setSource('cache');
    } else {
      setForecasts({}); setMarine(null); setExtended(null); setUpdatedAt(null); setSource('none');
    }
    setBusy(false);
  }, [location]);

  const refresh = useCallback((force: boolean) => {
    if (!force && Date.now() - lastLoadAt.current < MIN_REFRESH_MS) return;
    lastLoadAt.current = Date.now();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    void load(controller.signal);
  }, [load]);

  useEffect(() => {
    // Deferred by a microtask so the effect body itself performs no state update.
    void Promise.resolve().then(() => refresh(true));
    const interval = window.setInterval(() => refresh(true), REFRESH_MS);
    const onFocus = () => refresh(false);
    const onOnline = () => refresh(true);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      request.current?.abort();
    };
  }, [refresh]);

  const query = search.trim();
  useEffect(() => {
    if (query.length < 2) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const json = await fetchJson<{ results?: Record<string, unknown>[] }>(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setResults((json?.results || []).map(item => ({
        name: String(item.name),
        country: String(item.country || ''),
        latitude: Number(item.latitude),
        longitude: Number(item.longitude),
      })).filter(isLocation));
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => {
    if (!searchOpen && !settingsOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSearchOpen(false); setSettingsOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = previous; };
  }, [searchOpen, settingsOpen]);

  const consensus = useMemo(() => buildConsensus(forecasts), [forecasts]);
  const current = activeModel === 'MEAN' ? consensus : (forecasts[activeModel] || null);
  const anyModelLoaded = Object.keys(forecasts).length > 0;
  const nowIndex = useMemo(() => nowIndexFor(current), [current]);
  const currentTemp = reading(current, 'temperature_2m', nowIndex);
  const currentWind = reading(current, 'wind_speed_10m', nowIndex);
  const currentDir = reading(current, 'wind_direction_10m', nowIndex);
  const currentCloud = reading(current, 'cloud_cover', nowIndex);
  const currentRain = reading(current, 'precipitation', nowIndex);

  const days = useMemo(() => {
    const times = extended?.hourly?.time?.length ? extended.hourly.time : (current?.hourly?.time || []);
    return Array.from(new Set(times.map(time => time.slice(0, 10)))).slice(0, 21);
  }, [current, extended]);
  // Clamped rather than corrected in an effect, so a shrinking day strip can
  // never leave the UI pointing at a day that no longer exists.
  const dayIndex = days.length ? Math.min(selectedDay, days.length - 1) : 0;
  const selectedDate = days[dayIndex];

  // The operational time axis always spans the full 16 days; only the values
  // stop. Availability therefore has to be decided on the values themselves.
  const usingExtended = Boolean(selectedDate && !coversDate(current, selectedDate) && coversDate(extended, selectedDate));
  const forecastData = usingExtended ? extended : current;
  const dataNowIndex = useMemo(() => nowIndexFor(forecastData), [forecastData]);
  const forecastIndexes = useMemo(() => daySlots(forecastData, selectedDate, dataNowIndex), [forecastData, selectedDate, dataNowIndex]);

  const representativeIndex = forecastIndexes[Math.min(4, forecastIndexes.length - 1)] ?? 0;
  const spreadTemp = usingExtended ? reading(extended, 'temperature_2m_spread', representativeIndex) : null;
  const spreadWind = usingExtended ? reading(extended, 'wind_speed_10m_spread', representativeIndex) : null;
  const meanSpread = activeModel === 'MEAN' ? reading(current, 'wind_speed_10m' + SPREAD_SUFFIX, representativeIndex) : null;
  const meanCount = activeModel === 'MEAN' ? reading(current, 'wind_speed_10m' + COUNT_SUFFIX, representativeIndex) : null;
  const sourceDetail = usingExtended
    ? `GEFS ensemble mean${spreadTemp !== null ? ` · ±${spreadTemp.toFixed(1)}°C` : ''}${spreadWind !== null ? ` · wind ±${spreadWind.toFixed(1)} kt` : ''}`
    : activeModel === 'MEAN'
      ? current
        ? `Mean of ${meanCount ?? consensus?.members ?? 0} models${meanSpread !== null ? ` · wind spread ${meanSpread.toFixed(1)} kt` : ''}`
        : 'At least two models are needed for a mean'
      : current ? `${activeModel} operational model` : `${activeModel} returned no data`;
  const modelSubject = activeModel === 'MEAN' ? 'The model mean' : activeModel;
  const dayHeading = selectedDate ? `${dayLabel(selectedDate).dow} ${dayLabel(selectedDate).date}` : 'Forecast';

  const compareIndexes = useMemo(() => stepIndexes(current, nowIndex, 3, 8), [current, nowIndex]);
  const tableData = useMemo(() => withMarine(forecastData, marine), [forecastData, marine]);

  const weatherDayIndexes = useMemo(() => indexesForDate(forecastData, selectedDate), [forecastData, selectedDate]);
  const marineDayIndexes = useMemo(() => indexesForDate(marine, selectedDate), [marine, selectedDate]);
  const peakWave = useMemo(() => maximumReading(marine, 'wave_height', marineDayIndexes), [marine, marineDayIndexes]);
  const rainChance = useMemo(() => maximumReading(forecastData, 'precipitation_probability', weatherDayIndexes), [forecastData, weatherDayIndexes]);
  const peakCape = useMemo(() => maximumReading(forecastData, 'cape', weatherDayIndexes), [forecastData, weatherDayIndexes]);
  const dailyRain = useMemo(() => {
    const values = weatherDayIndexes
      .map(index => reading(forecastData, 'precipitation', index))
      .filter((value): value is number => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }, [forecastData, weatherDayIndexes]);
  const hasRainChance = hasSeries(forecastData, 'precipitation_probability');
  const hasCape = hasSeries(forecastData, 'cape');

  const confidence = dayIndex < 5
    ? { label: 'High confidence', className: 'high', detail: 'Best operational guidance' }
    : dayIndex < 10
      ? { label: 'Medium confidence', className: 'medium', detail: 'Model differences are increasing' }
      : dayIndex < 16
        ? { label: 'Low confidence', className: 'low', detail: 'Use as planning guidance only' }
        : { label: 'Very low confidence', className: 'very-low', detail: 'Experimental long-range trend' };

  const alertKey = hasSeries(current, 'wind_gusts_10m') ? 'wind_gusts_10m' : 'wind_speed_10m';
  const windAlertHit = useMemo(
    () => findWindAlert(current, nowIndex, windAlert, alertKey),
    [current, nowIndex, windAlert, alertKey],
  );

  useEffect(() => {
    if (!windAlertHit) return;
    const key = `${locationId(location)}|${windAlert}|${windAlertHit.time}`;
    if (notified.current === key) return;
    notified.current = key;
    // Android WebView exposes no Notification API at all, so the in-app banner
    // is the channel that always works and this is a best-effort extra.
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      new Notification('WeatherDeck wind alert', {
        body: `${windAlertHit.value.toFixed(0)} kt around ${formatHour(windAlertHit.time)} — ${location.name}`,
      });
    } catch { /* unsupported in this container */ }
  }, [windAlertHit, location, windAlert]);

  const stale = source === 'cache' || (updatedAt !== null && now > 0 && now - updatedAt > STALE_AFTER_MS);
  const statusLine = busy
    ? 'Updating live forecast…'
    : source === 'none'
      ? 'No forecast data available'
      : `${weatherLabel(currentCloud, currentRain)}${updatedAt ? ` · Updated ${clockLabel(updatedAt)}` : ''}${source === 'cache' ? ' · offline copy' : ''}`;

  const isSaved = favorites.some(favorite => locationId(favorite) === locationId(location));

  function persistFavorites(next: Location[]) {
    setFavorites(next);
    writeStorage(FAVORITES_KEY, JSON.stringify(next));
  }
  function toggleFavorite() {
    persistFavorites(isSaved ? favorites.filter(f => locationId(f) !== locationId(location)) : [...favorites, location]);
  }
  function removeFavorite(target: Location) {
    persistFavorites(favorites.filter(f => locationId(f) !== locationId(target)));
  }
  function selectLocation(next: Location) {
    setLocation(next); setSelectedDay(0); setSearchOpen(false); setSearch(''); setResults(NO_RESULTS); setGpsError('');
  }
  function changeWindAlert(value: number) {
    setWindAlert(value);
    writeStorage(WIND_ALERT_KEY, String(value));
  }
  function requestGps() {
    if (!navigator.geolocation) { setGpsError('This device does not expose a location service.'); return; }
    setGpsError('');
    navigator.geolocation.getCurrentPosition(
      position => selectLocation({
        name: 'Current location',
        country: '',
        latitude: Number(position.coords.latitude.toFixed(4)),
        longitude: Number(position.coords.longitude.toFixed(4)),
      }),
      error => setGpsError(error.code === error.PERMISSION_DENIED
        ? 'Location permission was denied. Enable it in system settings to use GPS.'
        : 'Could not get a GPS fix. Try again outdoors, or search for the place instead.'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }
  async function enableAlerts() {
    if (typeof Notification === 'undefined') return;
    try { setNotifyState(await Notification.requestPermission()); } catch { setNotifyState('denied'); }
  }

  const visibleResults = query.length < 2 ? NO_RESULTS : results;

  return (
    <main className="app-shell">
      <header className="topbar">
        <button type="button" className="brand-button" onClick={() => setActiveView('Forecast')} aria-label="WeatherDeck home">
          <span className="brand-mark" aria-hidden="true">W</span>
          <span><b>WeatherDeck</b><small>Personal forecast console</small></span>
        </button>
        <div className="top-actions">
          <span className={`connection ${online ? 'online' : 'offline'}`}>{online ? 'LIVE' : 'OFFLINE'}</span>
          <button type="button" className={`icon-button ${busy ? 'spinning' : ''}`} onClick={() => refresh(true)} disabled={busy} aria-label="Refresh forecast">↻</button>
          <button type="button" className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Settings">≡</button>
        </div>
      </header>

      <section className="location-bar">
        <button type="button" onClick={() => setSearchOpen(true)}>
          <span className="pin" aria-hidden="true">⌖</span>
          <span><b>{location.name}</b><small>{location.country || `${location.latitude.toFixed(2)}, ${location.longitude.toFixed(2)}`}</small></span>
          <i aria-hidden="true">⌄</i>
        </button>
        <button type="button" className={`round-button ${isSaved ? 'active' : ''}`} onClick={toggleFavorite} aria-pressed={isSaved} aria-label={isSaved ? 'Remove saved location' : 'Save location'}>{isSaved ? '★' : '☆'}</button>
      </section>

      {stale && <p className="stale-note" role="status">Showing the last saved forecast{updatedAt ? ` from ${new Date(updatedAt).toLocaleString()}` : ''}. Values may be out of date.</p>}

      {activeView === 'Forecast' && <>
        <section className="hero-card">
          <div className="hero-weather">
            <p className="muted">{statusLine}</p>
            <div className="current-reading">
              <strong>{currentTemp === null ? '—' : `${Math.round(currentTemp)}°`}</strong>
              <span>{rounded(reading(current, 'relative_humidity_2m', nowIndex))}% humidity<br />{rounded(reading(current, 'pressure_msl', nowIndex))} hPa</span>
            </div>
          </div>
          <div className="wind-summary">
            <span className="compass" style={currentDir === null ? undefined : { transform: `rotate(${currentDir}deg)` }} aria-hidden="true">{currentDir === null ? '·' : '↑'}</span>
            <div>
              <strong>{fixed(currentWind, 1)} kt</strong>
              <small>{cardinal(currentDir)} · Gusts {fixed(reading(current, 'wind_gusts_10m', nowIndex), 1)} kt</small>
            </div>
          </div>
        </section>

        {windAlertHit && <p className="alert-banner" role="status">Wind alert · {windAlertHit.value.toFixed(0)} kt expected around {formatHour(windAlertHit.time)} (threshold {windAlert} kt)</p>}
        {!current && anyModelLoaded && (
          <p className="notice">{activeModel === 'MEAN'
            ? 'A model mean needs at least two models, and only one returned data for this location.'
            : `${activeModel} did not return data for this location. Pick another model below.`}</p>
        )}

        <nav className="model-tabs" aria-label="Forecast model">
          {MODEL_KEYS.map(model => (
            <button type="button" className={activeModel === model ? 'active' : ''} aria-pressed={activeModel === model} onClick={() => setActiveModel(model)} key={model}>
              <span>{model}</span><small>{MODEL_META[model].resolution}</small>
            </button>
          ))}
          {consensus && (
            <button type="button" className={activeModel === 'MEAN' ? 'active' : ''} aria-pressed={activeModel === 'MEAN'} onClick={() => setActiveModel('MEAN')}>
              <span>MEAN</span><small>{consensus.members} models</small>
            </button>
          )}
          <button type="button" onClick={() => setActiveView('Compare')}><span>COMPARE</span><small>{MODEL_KEYS.length} models</small></button>
        </nav>

        <section className="days-strip">
          {days.map((day, index) => {
            const label = dayLabel(day);
            return (
              <button type="button" className={dayIndex === index ? 'active' : ''} aria-pressed={dayIndex === index} key={day} onClick={() => setSelectedDay(index)}>
                <b>{label.dow}</b><span>{label.date}</span><em>D+{index}</em>
              </button>
            );
          })}
        </section>

        <section className={`confidence-bar ${confidence.className}`}>
          <div><b>{confidence.label}</b><span>{confidence.detail}</span></div>
          <small>{sourceDetail}</small>
        </section>

        <ReadingTable
          data={tableData}
          indexes={forecastIndexes}
          rows={activeModel === 'MEAN' && !usingExtended ? MEAN_ROWS : FORECAST_ROWS}
          eyebrow="DETAILED FORECAST"
          title={`${dayHeading} · every 3 hours`}
          badge={usingExtended ? 'ENSEMBLE' : activeModel === 'MEAN' ? 'MODEL MEAN' : 'HOURLY'}
          subject={usingExtended ? 'The ensemble mean' : modelSubject}
          footnote={{ group: 'SEA', text: 'Sea rows come from the wave model and do not change with the selected weather model.' }}
        />

        <section className="quick-grid">
          <article>
            <span>WAVES · DAILY MAX</span>
            <strong>{peakWave ? `${peakWave.value.toFixed(1)} m` : '—'}</strong>
            <small>{peakWave ? `${fixed(reading(marine, 'wave_period', peakWave.index), 0)} s · ${cardinal(reading(marine, 'wave_direction', peakWave.index))}` : 'No marine data here'}</small>
          </article>
          <article>
            <span>PRECIPITATION · DAILY</span>
            <strong>{rainChance ? `${rainChance.value.toFixed(0)}%` : dailyRain !== null ? `${dailyRain.toFixed(1)} mm` : '—'}</strong>
            <small>{rainChance
              ? `${dailyRain !== null ? dailyRain.toFixed(1) : '—'} mm total expected`
              : hasRainChance ? 'No probability for this day' : 'Probability not published by this model'}</small>
          </article>
          <article>
            <span>INSTABILITY · DAILY MAX</span>
            <strong>{peakCape ? peakCape.value.toFixed(0) : '—'}</strong>
            <small>{peakCape ? 'CAPE · J/kg' : hasCape ? 'No CAPE for this day' : 'CAPE not published by this model'}</small>
          </article>
        </section>
      </>}

      {activeView === 'Compare' && <CompareView forecasts={forecasts} indexes={compareIndexes} onSelect={model => { setActiveModel(model); setSelectedDay(0); setActiveView('Forecast'); }} />}
      {activeView === 'Map' && <MapView location={location} />}
      {activeView === 'Saved' && <SavedView favorites={favorites} onSelect={selectLocation} onGps={requestGps} onRemove={removeFavorite} gpsError={gpsError} />}

      <nav className="bottom-nav" aria-label="Main navigation">
        {(['Forecast', 'Compare', 'Map', 'Saved'] as ViewKey[]).map(view => (
          <button type="button" key={view} className={activeView === view ? 'selected' : ''} aria-current={activeView === view ? 'page' : undefined} onClick={() => setActiveView(view)}>
            <span aria-hidden="true">{view === 'Forecast' ? '☼' : view === 'Compare' ? '≋' : view === 'Map' ? '⌖' : '☆'}</span>{view}
          </button>
        ))}
      </nav>

      {searchOpen && (
        <div className="sheet-backdrop">
          <button type="button" className="sheet-dismiss" aria-label="Close location picker" onClick={() => setSearchOpen(false)} />
          <section className="sheet search-sheet" role="dialog" aria-modal="true" aria-label="Choose location">
            <div className="sheet-handle" />
            <div className="sheet-title"><h2>Choose location</h2><button type="button" onClick={() => setSearchOpen(false)} aria-label="Close">×</button></div>
            <div className="search-box">
              <span aria-hidden="true">⌕</span>
              <input ref={searchInput} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search city or spot" aria-label="Search city or spot" />
            </div>
            <button type="button" className="gps-row" onClick={requestGps}>
              <span aria-hidden="true">◎</span>
              <div><b>Use current location</b><small>Get forecast from your GPS position</small></div>
            </button>
            {gpsError && <p className="notice" role="alert">{gpsError}</p>}
            {visibleResults.map(result => (
              <button type="button" className="result-row" key={locationId(result)} onClick={() => selectLocation(result)}>
                <span aria-hidden="true">⌖</span>
                <div><b>{result.name}</b><small>{result.country}</small></div>
              </button>
            ))}
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="sheet-backdrop">
          <button type="button" className="sheet-dismiss" aria-label="Close preferences" onClick={() => setSettingsOpen(false)} />
          <section className="sheet settings-sheet" role="dialog" aria-modal="true" aria-label="Preferences">
            <div className="sheet-handle" />
            <div className="sheet-title"><h2>Preferences</h2><button type="button" onClick={() => setSettingsOpen(false)} aria-label="Close">×</button></div>
            <label className="setting-row" htmlFor="wind-alert">
              <span><b>Wind alert</b><small>Banner when the next 24 h exceed this speed</small></span>
              <strong>{windAlert} kt</strong>
            </label>
            <input id="wind-alert" className="range" type="range" min="5" max="40" value={windAlert} onChange={event => changeWindAlert(Number(event.target.value))} />
            {notifyState === 'unsupported'
              ? <p className="notice">System notifications are not available in this app container. Wind alerts appear as an in-app banner while WeatherDeck is open.</p>
              : notifyState === 'granted'
                ? <p className="notice">System notifications are enabled. Alerts also appear in-app.</p>
                : <button type="button" className="primary-action" onClick={enableAlerts} disabled={notifyState === 'denied'}>{notifyState === 'denied' ? 'Notifications blocked in browser settings' : 'Enable browser notifications'}</button>}
            <div className="about-box">
              <b>Data sources</b>
              <p>ECMWF, NOAA GFS, DWD ICON and ECMWF AIFS via Open-Meteo. Marine forecasts combine public wave and ocean models. Not every model publishes every variable — missing readings are shown as “—” and never estimated.</p>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

/* ---------- views ---------- */

type Row = { key: string; group: string; label: string; unit: string; render: (data: Forecast | null, index: number) => ReactNode };

const EMPTY_CELL = <span className="table-empty">—</span>;
function numberCell(data: Forecast | null, key: string, index: number, format: (value: number) => ReactNode) {
  const value = reading(data, key, index);
  return value === null ? EMPTY_CELL : format(value);
}
function arrowCell(data: Forecast | null, key: string, index: number) {
  return numberCell(data, key, index, value => <span className="table-arrow" style={{ transform: `rotate(${value}deg)` }}>↑</span>);
}

const WEATHER_ROWS: Row[] = [
  { key: 'wind_direction_10m', group: 'AIR', label: 'Direction', unit: '', render: (data, index) => arrowCell(data, 'wind_direction_10m', index) },
  { key: 'wind_speed_10m', group: 'AIR', label: 'Wind', unit: 'kt', render: (data, index) => numberCell(data, 'wind_speed_10m', index, value => value.toFixed(1)) },
  { key: 'wind_gusts_10m', group: 'AIR', label: 'Gusts', unit: 'kt', render: (data, index) => numberCell(data, 'wind_gusts_10m', index, value => value.toFixed(1)) },
  { key: 'temperature_2m', group: 'AIR', label: 'Temperature', unit: '°C', render: (data, index) => numberCell(data, 'temperature_2m', index, value => <span className="temp-pill">{Math.round(value)}°</span>) },
  { key: 'pressure_msl', group: 'AIR', label: 'Pressure', unit: 'hPa', render: (data, index) => numberCell(data, 'pressure_msl', index, value => Math.round(value)) },
  { key: 'precipitation', group: 'AIR', label: 'Rain', unit: 'mm', render: (data, index) => numberCell(data, 'precipitation', index, value => value.toFixed(1)) },
  { key: 'cloud_cover', group: 'AIR', label: 'Clouds', unit: '%', render: (data, index) => numberCell(data, 'cloud_cover', index, value => Math.round(value)) },
];

// Shown only for the mean: a mean is worth no more than the agreement behind
// it, so the spread and the number of contributing models sit in the table.
const AGREEMENT_ROWS: Row[] = [
  {
    key: 'wind_speed_10m' + SPREAD_SUFFIX,
    group: 'MODEL AGREEMENT',
    label: 'Wind spread',
    unit: 'kt',
    render: (data, index) => numberCell(data, 'wind_speed_10m' + SPREAD_SUFFIX, index,
      value => <span className={`agreement ${value < 3 ? 'good' : value < 6 ? 'fair' : 'poor'}`}>{value.toFixed(1)}</span>),
  },
  {
    key: 'wind_speed_10m' + COUNT_SUFFIX,
    group: 'MODEL AGREEMENT',
    label: 'Models used',
    unit: `of ${MODEL_KEYS.length}`,
    render: (data, index) => numberCell(data, 'wind_speed_10m' + COUNT_SUFFIX, index, value => String(value)),
  },
];


const MARINE_ROWS: Row[] = [
  { key: 'wave_direction', group: 'SEA', label: 'Direction', unit: '', render: (data, index) => arrowCell(data, 'wave_direction', index) },
  { key: 'wave_height', group: 'SEA', label: 'Waves', unit: 'm', render: (data, index) => numberCell(data, 'wave_height', index, value => value.toFixed(1)) },
  { key: 'wave_period', group: 'SEA', label: 'Period', unit: 's', render: (data, index) => numberCell(data, 'wave_period', index, value => value.toFixed(0)) },
  { key: 'swell_wave_height', group: 'SEA', label: 'Swell', unit: 'm', render: (data, index) => numberCell(data, 'swell_wave_height', index, value => value.toFixed(1)) },
  { key: 'swell_wave_period', group: 'SEA', label: 'Swell period', unit: 's', render: (data, index) => numberCell(data, 'swell_wave_period', index, value => value.toFixed(0)) },
  { key: 'wind_wave_height', group: 'SEA', label: 'Wind wave', unit: 'm', render: (data, index) => numberCell(data, 'wind_wave_height', index, value => value.toFixed(1)) },
  { key: 'ocean_current_velocity', group: 'SEA', label: 'Current', unit: 'km/h', render: (data, index) => numberCell(data, 'ocean_current_velocity', index, value => value.toFixed(2)) },
  { key: 'sea_level_height_msl', group: 'SEA', label: 'Sea level', unit: 'm', render: (data, index) => numberCell(data, 'sea_level_height_msl', index, value => value.toFixed(2)) },
];

const FORECAST_ROWS: Row[] = [...WEATHER_ROWS, ...MARINE_ROWS];
const MEAN_ROWS: Row[] = [...WEATHER_ROWS, ...AGREEMENT_ROWS, ...MARINE_ROWS];

// The column count travels to the grid as a custom property rather than a full
// grid-template-columns value, so the responsive rules in the stylesheet still
// win over the inline style.
function ReadingTable({ data, indexes, rows: candidates, badge, eyebrow, title, subject, footnote }: {
  data: Forecast | null;
  indexes: number[];
  rows: Row[];
  badge: string;
  eyebrow: string;
  title: string;
  subject: string;
  footnote?: { group: string; text: string };
}) {
  // Availability is judged on the hours actually on screen, so a variable the
  // model stops publishing part-way through the range drops out of that day
  // instead of rendering a row of dashes.
  const rows = candidates.filter(row => hasVisibleData(data, row.key, indexes));
  const missing = candidates.filter(row => !rows.includes(row));
  // A whole group that drops out is named once ("no sea data") rather than
  // listed row by row.
  const missingCopy = [...new Set(missing.map(row => row.group))].map(group => {
    const absent = missing.filter(row => row.group === group);
    return absent.length === candidates.filter(row => row.group === group).length
      ? `no ${group.toLowerCase()} data`
      : `no ${absent.map(row => row.label.toLowerCase()).join(', ')}`;
  });
  return (
    <section className="forecast-card">
      <div className="section-title">
        <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>
        <span className="live-badge">{badge}</span>
      </div>
      {rows.length && indexes.length ? (
        <div className="weather-table" style={{ '--cols': indexes.length } as CSSProperties}>
          <div className="table-head table-label"><b>LOCAL TIME</b></div>
          {indexes.map(index => <div className="table-head" key={index}>{formatHour(data?.hourly?.time?.[index])}</div>)}
          {rows.map((row, position) => (
            <Fragment key={row.key}>
              {row.group !== rows[position - 1]?.group && (
                <div className="table-group"><span>{row.group}</span></div>
              )}
              <div className="table-row">
                <div className="table-label"><b>{row.label}</b><small>{row.unit}</small></div>
                {indexes.map(index => <div className="table-cell" key={index}>{row.render(data, index)}</div>)}
              </div>
            </Fragment>
          ))}
        </div>
      ) : (
        <p className="notice">{subject} publishes no data for this day. Choose another day or source.</p>
      )}
      {rows.length > 0 && missingCopy.length > 0 && (
        <p className="data-note">For this day: {missingCopy.join('; ')}.</p>
      )}
      {footnote && rows.some(row => row.group === footnote.group) && (
        <p className="data-note">{footnote.text}</p>
      )}
    </section>
  );
}

function CompareView({ forecasts, indexes, onSelect }: { forecasts: Partial<Record<ModelKey, Forecast>>; indexes: number[]; onSelect: (model: ModelKey) => void }) {
  const reference = MODEL_KEYS.map(key => forecasts[key]).find(Boolean) || null;
  const spreads = indexes.slice(0, 6).map(index => ({
    index,
    values: MODEL_KEYS
      .map(model => reading(forecasts[model] ?? null, 'wind_speed_10m', index))
      .filter((value): value is number => value !== null),
  }));
  const measured = spreads.filter(row => row.values.length > 1).map(row => Math.max(...row.values) - Math.min(...row.values));
  const averageSpread = measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
  const agreement = averageSpread === null
    ? 'NOT ENOUGH DATA'
    : averageSpread < 3 ? 'GOOD AGREEMENT' : averageSpread < 6 ? 'MODERATE SPREAD' : 'POOR AGREEMENT';

  return (
    <section className="view-page">
      <div className="view-heading"><p className="eyebrow">MODEL AGREEMENT</p><h1>Compare forecasts</h1><p>See where the leading forecast systems agree—and where they do not.</p></div>
      <div className="compare-grid">
        {MODEL_KEYS.map(model => {
          const data = forecasts[model] || null;
          const index = nowIndexFor(data);
          const temperature = reading(data, 'temperature_2m', index);
          return (
            <button type="button" key={model} onClick={() => onSelect(model)}>
              <div className="model-card-head"><span>{model}</span><small>{MODEL_META[model].provider}</small></div>
              <strong>{fixed(reading(data, 'wind_speed_10m', index), 1)} <i>kt</i></strong>
              <p>{temperature === null ? '—' : `${Math.round(temperature)}°`} · Gusts {fixed(reading(data, 'wind_gusts_10m', index), 0)} kt</p>
              <div className="mini-bars">
                {stepIndexes(data, index, 3, 6).map(barIndex => {
                  const value = reading(data, 'wind_speed_10m', barIndex);
                  return <span key={barIndex} style={{ height: `${value === null ? 3 : Math.min(44, 8 + value * 2)}px`, opacity: value === null ? 0.25 : 1 }} />;
                })}
              </div>
            </button>
          );
        })}
      </div>
      <section className="agreement-card">
        <div className="section-title">
          <div><p className="eyebrow">NEXT 24 HOURS</p><h2>Wind spread</h2></div>
          <span className="agreement-score">{agreement}</span>
        </div>
        {spreads.map(({ index, values }) => {
          const time = formatHour(reference?.hourly?.time?.[index]);
          if (!values.length) return <div className="spread-row" key={index}><time>{time}</time><div /><b>—</b></div>;
          const min = Math.min(...values);
          const max = Math.max(...values);
          return (
            <div className="spread-row" key={index}>
              <time>{time}</time>
              <div><span style={{ left: `${Math.min(75, min * 3)}%`, width: `${Math.max(4, (max - min) * 3)}%` }} /></div>
              <b>{min.toFixed(0)}–{max.toFixed(0)} kt</b>
            </div>
          );
        })}
      </section>
    </section>
  );
}

function MapView({ location }: { location: Location }) {
  const span = 0.35;
  const bbox = `${location.longitude - span},${location.latitude - span},${location.longitude + span},${location.latitude + span}`;
  return (
    <section className="view-page map-page">
      <div className="view-heading"><p className="eyebrow">FORECAST MAP</p><h1>Explore the area</h1><p>The map marks the exact point the forecast is calculated for. Search a place to move it.</p></div>
      <div className="map-frame">
        <iframe
          title={`Map of ${location.name}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          src={`https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${location.latitude},${location.longitude}`}
        />
        <div className="map-pin"><span aria-hidden="true">⌖</span><b>{location.name}</b></div>
      </div>
      <p className="data-note">Map data © OpenStreetMap contributors. Weather overlays are not part of this build.</p>
    </section>
  );
}

function SavedView({ favorites, onSelect, onGps, onRemove, gpsError }: { favorites: Location[]; onSelect: (location: Location) => void; onGps: () => void; onRemove: (location: Location) => void; gpsError: string }) {
  return (
    <section className="view-page">
      <div className="view-heading"><p className="eyebrow">QUICK ACCESS</p><h1>Saved spots</h1><p>Your favorite forecasts stay on this device.</p></div>
      <button type="button" className="saved-location gps" onClick={onGps}>
        <span aria-hidden="true">◎</span>
        <div><b>Current location</b><small>Use GPS coordinates</small></div>
        <i aria-hidden="true">›</i>
      </button>
      {gpsError && <p className="notice" role="alert">{gpsError}</p>}
      {favorites.length === 0 && <p className="notice">No saved spots yet. Tap the star next to a location name to keep it here.</p>}
      {favorites.map(favorite => (
        <div className="saved-row" key={locationId(favorite)}>
          <button type="button" className="saved-location" onClick={() => onSelect(favorite)}>
            <span aria-hidden="true">☆</span>
            <div><b>{favorite.name}</b><small>{favorite.country ? `${favorite.country} · ` : ''}{favorite.latitude.toFixed(2)}, {favorite.longitude.toFixed(2)}</small></div>
            <i aria-hidden="true">›</i>
          </button>
          <button type="button" className="remove-button" onClick={() => onRemove(favorite)} aria-label={`Remove ${favorite.name}`}>×</button>
        </div>
      ))}
    </section>
  );
}
