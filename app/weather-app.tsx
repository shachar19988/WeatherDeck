import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

type Location = { name: string; country: string; latitude: number; longitude: number };
type Series = (number | null)[];
type Hourly = { time: string[] } & Record<string, Series | string[]>;
type Forecast = { hourly: Hourly; hourly_units?: Record<string, string>; utc_offset_seconds?: number };
type ModelKey = 'ECMWF' | 'GFS' | 'ICON' | 'AIFS' | 'UKMO' | 'GEM';
type ActiveModel = ModelKey | 'MEAN';
type ViewKey = 'Forecast' | 'Map' | 'Saved';
type DataSource = 'live' | 'cache' | 'none';
type CachePayload = { forecasts: Partial<Record<ModelKey, Forecast>>; marine: Forecast | null; extended: Forecast | null; savedAt: number };

/**
 * Six models, chosen by measurement rather than by reputation.
 *
 * KNMI, DMI and MET Norway were tried and dropped: for this coast their series
 * come back byte-identical to ECMWF, because their high-resolution domains stop
 * well short of the eastern Mediterranean and they serve IFS instead. Adding
 * them would have weighted ECMWF three times over inside a mean that claimed
 * seven independent members.
 *
 * UKMO and GEM do differ here — 1.9 and 1.4 knots of mean absolute difference
 * from ECMWF respectively — so they add real spread. Both run shorter than the
 * others, which the table already handles by deciding coverage on the values.
 */
const MODEL_IDS: Record<ModelKey, string> = {
  ECMWF: 'ecmwf_ifs', GFS: 'gfs_seamless', ICON: 'icon_global',
  AIFS: 'ecmwf_aifs025_single', UKMO: 'ukmo_seamless', GEM: 'gem_seamless',
};
const MODEL_KEYS = Object.keys(MODEL_IDS) as ModelKey[];
const MODEL_META: Record<ModelKey, { provider: string; resolution: string }> = {
  ECMWF: { provider: 'European Centre', resolution: '9 km' },
  GFS: { provider: 'NOAA', resolution: '11–25 km' },
  ICON: { provider: 'DWD', resolution: '11 km' },
  AIFS: { provider: 'ECMWF AI', resolution: '25 km' },
  UKMO: { provider: 'UK Met Office', resolution: '10 km' },
  GEM: { provider: 'Env. Canada', resolution: '15 km' },
};
const DEFAULT_LOCATION: Location = { name: 'Haifa', country: 'Israel', latitude: 32.794, longitude: 34.9896 };
const WEATHER_VARS = 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cape,is_day';
const LONG_RANGE_VARS = 'temperature_2m,temperature_2m_spread,relative_humidity_2m,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_speed_10m_spread,wind_direction_10m,wind_gusts_10m';
const MARINE_VARS = 'wave_height,wave_direction,wave_period,sea_surface_temperature,swell_wave_height,swell_wave_direction,swell_wave_period,wind_wave_height,wind_wave_period,ocean_current_velocity,ocean_current_direction,sea_level_height_msl';

const SPREAD_SUFFIX = '__spread';
const COUNT_SUFFIX = '__models';
const CONSENSUS_KEYS = ['temperature_2m', 'relative_humidity_2m', 'precipitation_probability', 'precipitation', 'cloud_cover', 'pressure_msl', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'cape'];
// Bearings cannot be averaged arithmetically: the mean of 350 and 10 is 180,
// which points the opposite way. They are averaged as unit vectors instead.
const CIRCULAR_KEYS = new Set(['wind_direction_10m']);

/*
 * A disagreement warning that fires every day is wallpaper, so these are set
 * from what the models actually do here rather than from a round number.
 * Measured over ten days at Haifa: wave spread ran a median of 0.12 m and a
 * 90th percentile of 0.22, wind spread a median of 3.7 kt and a 90th of 5.6.
 * These sit just above that, so a split reads as unusual — which is the only
 * thing that makes it worth reading.
 */
const SPLIT_WAVE_M = 0.25;
const SPLIT_WIND_KT = 6;
const WIND_AGREEMENT_KEYS = ['wind_speed_10m' + SPREAD_SUFFIX, 'wind_speed_10m' + COUNT_SUFFIX];

const OFFSHORE_KEY = 'offshore';
const SHORE_PREFIX = 'weatherdeck:shore:';
const SHORE_SECTORS = 16;
const SHORE_RINGS_KM = [5, 12];
type ShoreMask = { sectors: boolean[]; water: boolean };
/**
 * Waves do not come from the six weather models in the picker — they come from
 * wave models, and until now from exactly one of them, so the sea was the one
 * quantity in this app that could never be doubted. Asking several the same
 * question is what makes "how sure is this" answerable for the water too.
 *
 * best_match is deliberately absent. Measured at Haifa, Biarritz and Bali it is
 * byte-identical to meteofrance_wave, so keeping both would weight MeteoFrance
 * twice and quietly narrow the spread. ncep_gfswave025 is out for a different
 * reason: at Biarritz it sits 1.2 m from every other model while its own finer
 * sibling agrees with them, which is a grid point in the wrong place rather
 * than a real disagreement.
 *
 * Regional models simply do not answer outside their domain — ewam is missing
 * at Bali, and both it and ncep at Cape Town — and the API drops them without
 * complaint. Each hour therefore carries how many models it is made of.
 */
const WAVE_MODELS = 'ecmwf_wam025,gwam,ewam,ncep_gfswave016,meteofrance_wave';
const WAVE_ENSEMBLE_KEYS = ['wave_height', 'swell_wave_height', 'swell_wave_period', 'wind_wave_height'];

const MARINE_KEYS = [
  ...MARINE_VARS.split(','),
  ...WAVE_ENSEMBLE_KEYS.flatMap(key => [key + COUNT_SUFFIX, key + SPREAD_SUFFIX]),
];
const MODEL_ROW_PREFIX = 'model:';

/**
 * One severity language, green through yellow to red, shared by every reading
 * that can make a day unusable. Each reading brings its own thresholds; the
 * colours never change.
 *
 * A severity scale rather than a plain magnitude one: on a board or at a helm,
 * 8 kt and 28 kt are not two amounts of the same thing, they are two different
 * days, and green-to-red is the convention that already means that. The row
 * label says which reading it is; the colour says how much it matters, and it
 * means the same thing wherever it appears.
 *
 * Every band's ink was checked against its own fill rather than picked by eye —
 * worst case 4.86:1, which matters on a phone in direct sun as much as anywhere.
 * Each cell prints its number too, so colour is never the only channel.
 */
const SEVERITY = [
  { fill: '#0a6e3a', ink: '#ffffff' },
  { fill: '#2f9412', ink: '#12100a' },
  { fill: '#8ab800', ink: '#12100a' },
  { fill: '#f0c000', ink: '#12100a' },
  { fill: '#f28a00', ink: '#12100a' },
  { fill: '#e2551c', ink: '#12100a' },
  { fill: '#c81e1e', ink: '#ffffff' },
];
function banded(limits: number[]) {
  return limits.map((limit, index) => ({ limit, ...SEVERITY[index] }));
}
// Green to 10 kt, deepest red from 25 up.
/**
 * How far out the day is, which is a different thing from how rough it is. This
 * used to be a card of its own above the graph; it now tints the day chips and
 * the table's eyebrow instead, because a reliability hint that costs a block of
 * screen is being charged more than it is worth.
 */
function confidenceAt(dayIndex: number) {
  return dayIndex < 5
    ? { label: 'High confidence', className: 'high', detail: 'Best operational guidance' }
    : dayIndex < 10
      ? { label: 'Medium confidence', className: 'medium', detail: 'Model differences are increasing' }
      : dayIndex < 16
        ? { label: 'Low confidence', className: 'low', detail: 'Use as planning guidance only' }
        : { label: 'Very low confidence', className: 'very-low', detail: 'Experimental long-range trend' };
}

const WIND_SCALE = banded([10, 13, 16, 19, 22, 25, Infinity]);
// Green to half a metre, deepest red from two up.
const WAVE_SCALE = banded([0.5, 0.8, 1.1, 1.4, 1.7, 2, Infinity]);
function windTone(value: number) {
  return WIND_SCALE.find(band => value < band.limit) ?? WIND_SCALE[WIND_SCALE.length - 1];
}

/**
 * Temperature reads cool to warm. It never enters the wind ramp's green, and it
 * is a different row, so the two scales do not compete. Every band's ink was
 * checked against its own fill; worst case 5.20:1.
 */
const TEMP_SCALE = [
  { limit: 8, fill: '#2a6fb0', ink: '#ffffff' },
  { limit: 14, fill: '#3f93b8', ink: '#12100a' },
  { limit: 19, fill: '#4aa596', ink: '#12100a' },
  { limit: 24, fill: '#c9a72e', ink: '#12100a' },
  { limit: 29, fill: '#e08a2c', ink: '#12100a' },
  { limit: 34, fill: '#dd5f28', ink: '#12100a' },
  { limit: Infinity, fill: '#c8332a', ink: '#ffffff' },
];
function tempTone(value: number) {
  return TEMP_SCALE.find(band => value < band.limit) ?? TEMP_SCALE[TEMP_SCALE.length - 1];
}

/**
 * A skipper thinks in force, not knots. Upper bounds of each force in knots,
 * from the Beaufort scale as defined for wind at 10 m — which is exactly the
 * height Open-Meteo reports.
 */
const BEAUFORT_LIMITS = [1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64];
const BEAUFORT_NAMES = ['calm', 'light air', 'light breeze', 'gentle breeze', 'moderate breeze',
  'fresh breeze', 'strong breeze', 'near gale', 'gale', 'strong gale', 'storm', 'violent storm', 'hurricane'];
function beaufort(knots: number | null) {
  if (knots === null) return null;
  const force = BEAUFORT_LIMITS.findIndex(limit => knots < limit);
  const index = force < 0 ? BEAUFORT_LIMITS.length : force;
  return { force: index, name: BEAUFORT_NAMES[index] };
}

function waveTone(value: number) {
  return WAVE_SCALE.find(band => value < band.limit) ?? WAVE_SCALE[WAVE_SCALE.length - 1];
}

/**
 * Averaged in plain sRGB. Adjacent ramp steps are close enough that a
 * perceptual blend would not look different, and this runs per cell.
 */
function mixHex(a: string, b: string) {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  const pair = (at: number) => Math.round((channel(a, at) + channel(b, at)) / 2).toString(16).padStart(2, '0');
  return `#${pair(1)}${pair(3)}${pair(5)}`;
}

const CACHE_PREFIX = 'weatherdeck:cache:';
const FAVORITES_KEY = 'weatherdeck:favorites';
const WIND_ALERT_KEY = 'weatherdeck:wind-alert';
// Read by the Android wrapper so the home-screen widget follows the same place.
const LOCATION_KEY = 'weatherdeck:location';
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
// Sources run on their own, sometimes shorter, time axes. Rather than extra
// screens, their series are remapped onto the displayed axis by timestamp so one
// table can carry the whole forecast for a day.
function withSeries(base: Forecast | null, source: Forecast | null | undefined, keys: string[], prefix = ''): Forecast | null {
  if (!base) return null;
  if (!source?.hourly?.time?.length) return base;
  const positions = new Map<string, number>();
  source.hourly.time.forEach((time, index) => positions.set(time, index));
  const hourly: Record<string, Series | string[]> = { ...base.hourly };
  for (const key of keys) {
    hourly[prefix + key] = base.hourly.time.map(time => {
      const index = positions.get(time);
      return index === undefined ? null : reading(source, key, index);
    });
  }
  return { ...base, hourly: hourly as Hourly };
}
/**
 * Joins the operational model to the ensemble into one series covering the whole
 * range: the operational value wherever it exists, the ensemble beyond it.
 *
 * The table used to be built one day at a time, which let each day pick its own
 * source. A table that scrolls straight through three weeks cannot do that, so
 * the choice moves here, hour by hour, and stays the rule the app already
 * follows — operational while it publishes, ensemble after.
 */
function stitch(primary: Forecast | null, fallback: Forecast | null): Forecast | null {
  if (!fallback?.hourly?.time?.length) return primary;
  if (!primary?.hourly?.time?.length) return fallback;
  const axis = primary.hourly.time.length >= fallback.hourly.time.length ? primary : fallback;
  const other = axis === primary ? fallback : primary;
  const positions = new Map<string, number>();
  other.hourly.time.forEach((time, index) => positions.set(time, index));

  const keys = new Set([...Object.keys(primary.hourly), ...Object.keys(fallback.hourly)]);
  keys.delete('time');
  const hourly: Record<string, Series | string[]> = { time: axis.hourly.time };
  for (const key of keys) {
    hourly[key] = axis.hourly.time.map((time, index) => {
      const at = (source: Forecast) => reading(source, key, source === axis ? index : (positions.get(time) ?? -1));
      return at(primary) ?? at(fallback);
    });
  }
  return { hourly: hourly as Hourly, utc_offset_seconds: axis.utc_offset_seconds };
}

/**
 * The ensemble publishes no is_day, so past the operational range every hour read
 * as unknown — and an unknown that counted as daylight quietly turned every night
 * out there into a paddling window.
 *
 * Daylight is astronomy, not forecast, so the pattern from the last day that does
 * publish it is reused by hour of day. Over the five or six days this fills, the
 * sunrise moves by a few minutes, well below the resolution anything here is
 * decided at.
 */
function carryDaylight(base: Forecast | null): Forecast | null {
  if (!base || !hasSeries(base, 'is_day')) return base;
  const pattern = new Map<string, number>();
  base.hourly.time.forEach((time, index) => {
    const value = reading(base, 'is_day', index);
    if (value !== null) pattern.set(time.slice(11, 13), value);
  });
  const hourly: Record<string, Series | string[]> = { ...base.hourly };
  hourly.is_day = base.hourly.time.map((time, index) =>
    reading(base, 'is_day', index) ?? pattern.get(time.slice(11, 13)) ?? null);
  return { ...base, hourly: hourly as Hourly };
}

const MATCH_KEY = 'profile_match';
const PROFILE_KEY = 'weatherdeck:profile';
const PLAN_KEY = 'weatherdeck:plan';
const MIN_WINDOW_HOURS = 2;

type Conditions = {
  wind: number | null;
  gust: number | null;
  wave: number | null;
  period: number | null;
  offshore: boolean;
  daylight: boolean;
  water: number | null;
  swell: number | null;
  swellPeriod: number | null;
  windWave: number | null;
};
/** A value at the precision it is printed at, so badges agree with the numbers. */
function shown(value: number | null, digits: number) {
  return value === null ? null : Number(value.toFixed(digits));
}

/** Drops the clauses whose reading is missing rather than printing "sea — m". */
function clauses(...parts: (string | null)[]) {
  return parts.filter((part): part is string => part !== null).join(' · ');
}

type Spell = { start: number; end: number; hours: number; wind: number | null; wave: number | null;
  period: number | null; water: number | null; swell: number | null; swellPeriod: number | null };
/**
 * Thresholds as plain numbers rather than as code, so the same set can be handed
 * to the Android side for the planned-day check without reimplementing any of
 * the rules in Java. One definition, two readers.
 */
type Limits = {
  waveMin?: number;
  waveMax?: number;
  /*
   * Total wave height answers "how much water is moving", which is the right
   * question for a flat-water paddle or a boat full of guests. It is the wrong
   * question for surfing one: 1.2 m of clean groundswell at 8 s is a session
   * and 1.2 m of local wind chop at 4 s is a washing machine, and until now
   * this app could not tell the two apart.
   */
  swellMin?: number;
  swellMax?: number;
  swellPeriodMin?: number;
  windWaveMax?: number;
  windMin?: number;
  windMax?: number;
  gustMax?: number;
  periodMin?: number;
  waterMin?: number;
  daylight?: boolean;
  noOffshore?: boolean;
};
function suitsLimits(at: Conditions, limits: Limits) {
  if (limits.daylight && !at.daylight) return false;
  if (limits.noOffshore && at.offshore) return false;
  if (limits.waveMin !== undefined && (at.wave === null || at.wave < limits.waveMin)) return false;
  if (limits.waveMax !== undefined && (at.wave === null || at.wave >= limits.waveMax)) return false;
  if (limits.swellMin !== undefined && (at.swell === null || at.swell < limits.swellMin)) return false;
  if (limits.swellMax !== undefined && (at.swell === null || at.swell >= limits.swellMax)) return false;
  if (limits.swellPeriodMin !== undefined && (at.swellPeriod ?? 0) < limits.swellPeriodMin) return false;
  if (limits.windWaveMax !== undefined && (at.windWave ?? 0) >= limits.windWaveMax) return false;
  if (limits.windMin !== undefined && (at.wind === null || at.wind < limits.windMin)) return false;
  if (limits.windMax !== undefined && (at.wind === null || at.wind > limits.windMax)) return false;
  if (limits.gustMax !== undefined && (at.gust ?? 0) >= limits.gustMax) return false;
  if (limits.periodMin !== undefined && (at.period ?? 0) < limits.periodMin) return false;
  if (limits.waterMin !== undefined && (at.water ?? -99) < limits.waterMin) return false;
  return true;
}

type Profile = {
  key: string;
  label: string;
  hint: string;
  limits: Limits;
  /** What makes this window worth taking, in the terms the sport is judged in. */
  why: (spell: Spell) => string;
  /**
   * The reading that decides which window is the pick. Rounded to the precision
   * it is displayed at, so the badge can never claim one sea is flatter than
   * another while both print 0.4 m.
   */
  pick: { of: (spell: Spell) => number | null; best: 'low' | 'high'; label: string };
};

/**
 * The same forecast answers a different question for each thing you might do
 * with it: 12 kt is a good afternoon on a yacht and the end of a paddle. Each
 * profile shows its own thresholds on its chip, because they are guesses about
 * someone else's sport and they should be easy to disagree with.
 *
 * The flat-water ceiling is 0.6 m rather than the 0.4 m first tried: measured
 * against ten days of this coast, the sea never once dropped below 0.38 m and
 * 0.4 m qualified nine daylight hours out of a hundred and thirty. A profile
 * that can never light up is no more use than one that never goes out.
 *
 * Offshore wind rules out both board profiles regardless of everything else —
 * it is the condition that takes a paddler out faster than they can come back —
 * and both want daylight. A yacht is not bound by either.
 */
const PROFILES: Profile[] = [
  {
    key: 'sup',
    label: 'SUP',
    hint: 'under 10 kt · under 0.6 m',
    limits: { daylight: true, noOffshore: true, windMax: 10, waveMax: 0.6 },
    why: spell => clauses(spell.wind === null ? null : `${spell.wind.toFixed(0)} kt`,
      spell.wave === null ? null : `sea ${spell.wave.toFixed(1)} m`),
    pick: { of: spell => shown(spell.wind, 0), best: 'low', label: 'lightest wind' },
  },
  {
    key: 'sup-surf',
    label: 'SUP surf',
    hint: 'swell 0.6-1.5 m · 6 s+ · little chop',
    /*
     * Judged on the swell alone, with the local wind sea held down separately.
     * The old rule used total height and total period, which cannot distinguish
     * a rideable swell from the same amount of chop.
     *
     * Six seconds, not seven, because this is the Mediterranean: measured over
     * ten days at Haifa the swell period ran a median of 5.1 s and never once
     * passed 7.7. A 7 s gate fired on 11 hours out of 240 — the top few per
     * cent of a short-fetch sea — where 6 s finds 26. Somewhere with real
     * groundswell this would want raising.
     */
    limits: { daylight: true, noOffshore: true, swellMin: 0.6, swellMax: 1.51, swellPeriodMin: 6, windWaveMax: 0.4, windMax: 12 },
    why: spell => clauses(spell.swell === null ? null : `swell ${spell.swell.toFixed(1)} m`,
      spell.swellPeriod === null ? null : `${spell.swellPeriod.toFixed(0)} s`,
      spell.wind === null ? null : `${spell.wind.toFixed(0)} kt`),
    pick: { of: spell => shown(spell.swellPeriod, 0), best: 'high', label: 'cleanest swell' },
  },
  {
    key: 'sail',
    label: 'Sailing',
    hint: 'under 0.7 m · 6-14 kt',
    /*
     * The sea comes first here and the wind second: this is a day out with
     * friends, some of whom have never sailed, and above about 0.7 m the boat
     * stops being fun for them long before it stops being safe. So the window is
     * picked on the flattest sea, not the best breeze.
     *
     * The ideal breeze is 8-12, but the band is 6-14 because on this coast the
     * two wishes fight each other: measured over ten days, the hours with a sea
     * under 0.7 m had a median wind of 4.4 kt and never once reached 10. Holding
     * out for 8-12 on flat water found three hours in ten days and no run longer
     * than one, so the profile would simply never have fired.
     */
    limits: { waveMax: 0.7, windMin: 6, windMax: 14, gustMax: 24 },
    why: spell => clauses(spell.wave === null ? null : `sea ${spell.wave.toFixed(1)} m`,
      spell.wind === null ? null : `${spell.wind.toFixed(0)} kt`),
    pick: { of: spell => shown(spell.wave, 1), best: 'low', label: 'flattest sea' },
  },
  {
    key: 'dive',
    label: 'Diving',
    hint: 'under 0.5 m · under 12 kt',
    limits: { daylight: true, waveMax: 0.5, windMax: 12 },
    why: spell => clauses(spell.wave === null ? null : `sea ${spell.wave.toFixed(1)} m`,
      spell.wind === null ? null : `${spell.wind.toFixed(0)} kt`),
    pick: { of: spell => shown(spell.wave, 1), best: 'low', label: 'calmest surface' },
  },
  {
    key: 'swim',
    label: 'Swimming',
    hint: 'under 0.5 m · under 15 kt · 22°C+',
    limits: { daylight: true, noOffshore: true, waveMax: 0.5, windMax: 15, waterMin: 22 },
    why: spell => clauses(spell.water === null ? null : `${spell.water.toFixed(0)}°C water`,
      spell.wave === null ? null : `sea ${spell.wave.toFixed(1)} m`),
    pick: { of: spell => shown(spell.water, 0), best: 'high', label: 'warmest water' },
  },
];

function conditionsAt(data: Forecast | null, index: number): Conditions {
  return {
    wind: reading(data, 'wind_speed_10m', index),
    gust: reading(data, 'wind_gusts_10m', index),
    wave: reading(data, 'wave_height', index),
    period: reading(data, 'wave_period', index),
    offshore: reading(data, OFFSHORE_KEY, index) === 1,
    daylight: reading(data, 'is_day', index) === 1,
    water: reading(data, 'sea_surface_temperature', index),
    swell: reading(data, 'swell_wave_height', index),
    swellPeriod: reading(data, 'swell_wave_period', index),
    windWave: reading(data, 'wind_wave_height', index),
  };
}
function withProfile(base: Forecast | null, profile: Profile | null): Forecast | null {
  if (!base || !profile) return base;
  const hourly: Record<string, Series | string[]> = { ...base.hourly };
  hourly[MATCH_KEY] = base.hourly.time.map((_, index) =>
    (suitsLimits(conditionsAt(base, index), profile.limits) ? 1 : null));
  return { ...base, hourly: hourly as Hourly };
}

/**
 * A day marked in advance — a trip already in the diary — and what the forecast
 * has done to it since. The point is not "what is Friday like" but "is Friday
 * still on", which is a different question and only answerable against what it
 * looked like when the plan was made.
 */
type Plan = { date: string; profile: string; setAt: number; hours: number; wind: number | null; wave: number | null };

/**
 * How far apart the models were across a day, which is a different question
 * from what they averaged to. A mean of 0.7 m built from 0.5 and 0.9 is not the
 * same forecast as one built from 0.68 and 0.72, and for a day already in the
 * diary the difference is whether to wait before cancelling.
 */
function agreementOn(data: Forecast | null, date: string) {
  const indexes = indexesForDate(data, date);
  const worst = (key: string) => {
    const values = indexes.map(index => reading(data, key + SPREAD_SUFFIX, index)).filter((v): v is number => v !== null);
    return values.length ? Math.max(...values) : null;
  };
  const wave = worst('wave_height');
  const wind = worst('wind_speed_10m');
  return {
    wave, wind,
    split: (wave !== null && wave >= SPLIT_WAVE_M) || (wind !== null && wind >= SPLIT_WIND_KT),
  };
}

function planReading(data: Forecast | null, date: string, profile: Profile) {
  const indexes = indexesForDate(data, date);
  const fits = indexes.filter(index => suitsLimits(conditionsAt(data, index), profile.limits));
  const window = fits.length ? fits : indexes;
  const mean = (key: string) => {
    const values = window.map(index => reading(data, key, index)).filter((v): v is number => v !== null);
    return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
  };
  return { hours: fits.length, wind: mean('wind_speed_10m'), wave: mean('wave_height') };
}

function meanOver(data: Forecast | null, key: string, from: number, to: number) {
  const values: number[] = [];
  for (let index = from; index <= to; index += 1) {
    const value = reading(data, key, index);
    if (value !== null) values.push(value);
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/**
 * Unbroken runs of suitable hours from now on, longest first — the question
 * actually being asked is not "is 14:00 any good" but "when can I go", and the
 * answer is more useful with an alternative attached. Ties go to the earlier
 * run, because a window today beats the same window on Thursday.
 */
function bestWindows(data: Forecast | null, from: number, count: number): Spell[] {
  const times = data?.hourly?.time || [];
  const runs: Spell[] = [];
  let runStart = -1;
  for (let index = from; index <= times.length; index += 1) {
    const suitable = index < times.length && reading(data, MATCH_KEY, index) === 1;
    if (suitable && runStart < 0) runStart = index;
    if (!suitable && runStart >= 0) {
      const end = index - 1;
      const hours = index - runStart;
      if (hours >= MIN_WINDOW_HOURS) {
        runs.push({
          start: runStart,
          end,
          hours,
          wind: meanOver(data, 'wind_speed_10m', runStart, end),
          wave: meanOver(data, 'wave_height', runStart, end),
          period: meanOver(data, 'wave_period', runStart, end),
          water: meanOver(data, 'sea_surface_temperature', runStart, end),
          swell: meanOver(data, 'swell_wave_height', runStart, end),
          swellPeriod: meanOver(data, 'swell_wave_period', runStart, end),
        });
      }
      runStart = -1;
    }
  }
  return runs.sort((a, b) => (b.hours - a.hours) || (a.start - b.start)).slice(0, count);
}

// One wind row per model, in place of a separate comparison screen.
function withModelWinds(base: Forecast | null, forecasts: Partial<Record<ModelKey, Forecast>>) {
  return MODEL_KEYS.reduce<Forecast | null>(
    (carrier, key) => withSeries(carrier, forecasts[key], ['wind_speed_10m'], `${MODEL_ROW_PREFIX}${key}:`),
    base,
  );
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
  // Daylight is a fact about the location, not a quantity to average.
  hourly.is_day = axis.hourly.is_day as Series;
  return { hourly: hourly as Hourly, utc_offset_seconds: axis.utc_offset_seconds, members: members.length };
}

/**
 * Replaces the single-source wave series with the mean of the wave models, and
 * records how far apart they were.
 *
 * The direction, water temperature and current stay as they were: those come
 * from one model whatever we do, and pretending otherwise by leaving a stale
 * spread beside them would be worse than having none.
 */
function withWaveConsensus(marine: Forecast | null, ensemble: Forecast | null): Forecast | null {
  const times = marine?.hourly?.time;
  if (!marine || !times?.length || !ensemble?.hourly?.time?.length) return marine;

  const positions = new Map<string, number>();
  ensemble.hourly.time.forEach((time, index) => positions.set(time, index));

  const hourly: Record<string, Series | string[]> = { ...marine.hourly };
  for (const key of WAVE_ENSEMBLE_KEYS) {
    const members = Object.keys(ensemble.hourly).filter(name => name.startsWith(key + '_'));
    if (!members.length) continue;
    const mean: Series = [];
    const count: Series = [];
    const spread: Series = [];
    for (const time of times) {
      const at = positions.get(time);
      const values: number[] = [];
      if (at !== undefined) {
        for (const name of members) {
          const value = reading(ensemble, name, at);
          if (value !== null) values.push(value);
        }
      }
      if (!values.length) { mean.push(null); count.push(null); spread.push(null); continue; }
      mean.push(values.reduce((sum, value) => sum + value, 0) / values.length);
      count.push(values.length);
      spread.push(values.length > 1 ? Math.max(...values) - Math.min(...values) : null);
    }
    hourly[key] = mean;
    hourly[key + COUNT_SUFFIX] = count;
    hourly[key + SPREAD_SUFFIX] = spread;
  }
  return { ...marine, hourly: hourly as Hourly };
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

/** Great-circle offset, used to lay a ring of probe points around a spot. */
function destination(latitude: number, longitude: number, bearing: number, km: number) {
  const radius = 6371;
  const angle = (bearing * Math.PI) / 180;
  const lat = (latitude * Math.PI) / 180;
  const lon = (longitude * Math.PI) / 180;
  const distance = km / radius;
  const nextLat = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(angle));
  const nextLon = lon + Math.atan2(
    Math.sin(angle) * Math.sin(distance) * Math.cos(lat),
    Math.cos(distance) - Math.sin(lat) * Math.sin(nextLat),
  );
  return [(nextLat * 180) / Math.PI, (nextLon * 180) / Math.PI] as const;
}
function sectorOf(bearing: number) {
  return Math.round((((bearing % 360) + 360) % 360) / (360 / SHORE_SECTORS)) % SHORE_SECTORS;
}
function shoreKey(location: Location) {
  return `${SHORE_PREFIX}${location.latitude.toFixed(2)},${location.longitude.toFixed(2)}`;
}

/**
 * Works out which way the open water lies, anywhere in the world, by asking
 * Open-Meteo's elevation endpoint about a ring of points around the spot: sea
 * reads as zero. The marine endpoint is no good for this — it snaps to a coarse
 * grid and answers for inland points near the coast.
 *
 * The result is kept as a 16-sector water mask rather than reduced to a single
 * bearing, because on a bay the water wraps around and one average angle
 * flattens exactly the detail that matters.
 */
async function fetchShore(location: Location, signal: AbortSignal): Promise<ShoreMask | null> {
  const latitudes: number[] = [];
  const longitudes: number[] = [];
  for (const km of SHORE_RINGS_KM) {
    for (let sector = 0; sector < SHORE_SECTORS; sector += 1) {
      const [lat, lon] = destination(location.latitude, location.longitude, (sector * 360) / SHORE_SECTORS, km);
      latitudes.push(lat);
      longitudes.push(lon);
    }
  }
  const json = await fetchJson<{ elevation?: (number | null)[] }>(
    `https://api.open-meteo.com/v1/elevation?latitude=${latitudes.map(v => v.toFixed(5)).join(',')}&longitude=${longitudes.map(v => v.toFixed(5)).join(',')}`,
    signal,
  );
  if (!json?.elevation?.length) return null;
  const sectors = new Array<boolean>(SHORE_SECTORS).fill(false);
  json.elevation.forEach((value, index) => {
    if (typeof value === 'number' && Number.isFinite(value) && value <= 1) sectors[index % SHORE_SECTORS] = true;
  });
  return { sectors, water: sectors.some(Boolean) };
}

/**
 * wind_direction_10m is the direction the wind blows *from*. Offshore means it
 * arrives over land and leaves over water — the case that carries a paddler out
 * to sea faster than they can come back.
 */
function isOffshore(mask: ShoreMask | null, windFrom: number | null) {
  if (!mask?.water || windFrom === null) return false;
  const from = sectorOf(windFrom);
  const before = (from + SHORE_SECTORS - 1) % SHORE_SECTORS;
  const after = (from + 1) % SHORE_SECTORS;
  // Requiring a neighbouring sector to agree keeps a wind sitting on a sector
  // boundary from flipping the warning on and off between runs, and keeps a lone
  // land cell in open water from raising one at all. A warning that cries wolf
  // is worse than no warning.
  const fromLand = !mask.sectors[from] && (!mask.sectors[before] || !mask.sectors[after]);
  return fromLand && mask.sectors[sectorOf(windFrom + 180)];
}
function withOffshore(base: Forecast | null, mask: ShoreMask | null): Forecast | null {
  if (!base) return null;
  if (!mask?.water) return base;
  const hourly: Record<string, Series | string[]> = { ...base.hourly };
  hourly[OFFSHORE_KEY] = base.hourly.time.map((_, index) =>
    (isOffshore(mask, reading(base, 'wind_direction_10m', index)) ? 1 : null));
  return { ...base, hourly: hourly as Hourly };
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
  const [compareModels, setCompareModels] = useState(false);
  const [now, setNow] = useState(0);
  const [shore, setShore] = useState<ShoreMask | null>(null);
  const [profileKey, setProfileKey] = useState<string>(() => readStorage(PROFILE_KEY) || '');
  const [plan, setPlan] = useState<Plan | null>(() => {
    const raw = readStorage(PLAN_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Plan;
      return parsed && typeof parsed.date === 'string' ? parsed : null;
    } catch { return null; }
  });

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

  useEffect(() => {
    writeStorage(LOCATION_KEY, JSON.stringify(location));
  }, [location]);

  // The coastline does not move, so this runs once per spot and is then cached.
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      const cached = readStorage(shoreKey(location));
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as ShoreMask;
          if (Array.isArray(parsed?.sectors) && parsed.sectors.length === SHORE_SECTORS) {
            setShore(parsed);
            return;
          }
        } catch { /* fall through and probe again */ }
      }
      const mask = await fetchShore(location, controller.signal);
      if (controller.signal.aborted) return;
      setShore(mask);
      if (mask) writeStorage(shoreKey(location), JSON.stringify(mask));
    });
    return () => controller.abort();
  }, [location]);

  const load = useCallback(async (signal: AbortSignal) => {
    setBusy(true);
    const base = `latitude=${location.latitude}&longitude=${location.longitude}&hourly=${WEATHER_VARS}&forecast_days=16&timezone=auto&wind_speed_unit=kn`;
    const [models, baseMarine, waveModels, nextExtended] = await Promise.all([
      Promise.all(MODEL_KEYS.map(key => fetchJson<Forecast>(`https://api.open-meteo.com/v1/forecast?${base}&models=${MODEL_IDS[key]}`, signal))),
      fetchJson<Forecast>(`https://marine-api.open-meteo.com/v1/marine?latitude=${location.latitude}&longitude=${location.longitude}&hourly=${MARINE_VARS}&forecast_days=10&timezone=auto`, signal),
      fetchJson<Forecast>(`https://marine-api.open-meteo.com/v1/marine?latitude=${location.latitude}&longitude=${location.longitude}&hourly=${WAVE_ENSEMBLE_KEYS.join(',')}&forecast_days=10&timezone=auto&models=${WAVE_MODELS}`, signal),
      fetchJson<Forecast>(`https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${location.latitude}&longitude=${location.longitude}&hourly=${LONG_RANGE_VARS}&forecast_days=21&timezone=auto&wind_speed_unit=kn&models=ncep_gefs05_ensemble_mean`, signal),
    ]);
    if (signal.aborted) return;

    // Merged before it is cached, so the cache holds what the table reads.
    const nextMarine = withWaveConsensus(baseMarine, waveModels);

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
  const currentForce = beaufort(currentWind);

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
  // The badge beside this already names the model, so for a single operational
  // run the source line would only say it twice and wrap on a phone doing it.
  // A mean or an ensemble carries its spread, which the badge does not.
  const sourceWorthSaying = usingExtended || activeModel === 'MEAN' || !current;
  const leadNote = sourceWorthSaying ? `${confidenceAt(dayIndex).label} · ${sourceDetail}` : confidenceAt(dayIndex).label;

  const profile = PROFILES.find(entry => entry.key === profileKey) ?? null;
  const planProfile = plan ? PROFILES.find(entry => entry.key === plan.profile) ?? null : null;
  const continuous = useMemo(() => stitch(current, extended), [current, extended]);
  const tableData = useMemo(() => {
    const withSea = withSeries(withSeries(continuous, marine, MARINE_KEYS), consensus ?? undefined, WIND_AGREEMENT_KEYS);
    // The ensemble carries no daylight flag; borrow it from any operational model.
    const lit = hasSeries(withSea, 'is_day') ? withSea : withSeries(withSea, current ?? undefined, ['is_day']);
    const flagged = withProfile(withOffshore(carryDaylight(lit), shore), profile);
    return compareModels ? withModelWinds(flagged, forecasts) : flagged;
  }, [continuous, marine, consensus, current, forecasts, compareModels, shore, profile]);

  // Every three-hourly slot of every day, in order — the table is one scroll
  // through the whole range rather than a view onto a chosen day.
  const tableColumns = useMemo(() => {
    const startAt = nowIndexFor(tableData);
    const columns: { index: number; date: string }[] = [];
    for (const day of days) {
      for (const index of daySlots(tableData, day, startAt)) columns.push({ index, date: day });
    }
    return columns;
  }, [tableData, days]);
  const ensembleDays = useMemo(
    () => new Set(days.filter(day => !coversDate(current, day))),
    [days, current],
  );
  // No profile means no match series, so both of these fall out at zero without
  // needing a branch — which also keeps the memos ones the compiler can hold on to.
  const spells = useMemo(() => bestWindows(tableData, nowIndexFor(tableData), 2), [tableData]);
  const matchesPerDay = useMemo(
    () => days.map(day => indexesForDate(tableData, day).filter(index => reading(tableData, MATCH_KEY, index) === 1).length),
    [days, tableData],
  );
  const tableRows = useMemo(() => [
    ...WEATHER_ROWS,
    ...(activeModel === 'MEAN' && !usingExtended ? AGREEMENT_ROWS : []),
    ...(compareModels ? MODEL_WIND_ROWS : []),
    ...MARINE_ROWS,
  ], [activeModel, usingExtended, compareModels]);

  // Windy-style day chips: the numbers that decide whether a day is worth
  // opening at all, read straight off the hourly series so they work for the
  // mean and the ensemble too.
  const dayStats = useMemo(() => days.map(day => {
    const source = coversDate(current, day) ? current : extended;
    const indexes = indexesForDate(source, day);
    const temperatures = indexes.map(index => reading(source, 'temperature_2m', index)).filter((v): v is number => v !== null);
    const winds = indexes.map(index => reading(source, 'wind_speed_10m', index)).filter((v): v is number => v !== null);
    return {
      low: temperatures.length ? Math.min(...temperatures) : null,
      high: temperatures.length ? Math.max(...temperatures) : null,
      wind: winds.length ? Math.max(...winds) : null,
    };
  }), [days, current, extended]);

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

  const confidence = confidenceAt(dayIndex);

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
    writeStorage(LOCATION_KEY, JSON.stringify(next));
  }
  /**
   * Marking a day records what it looked like at the time. Without that there is
   * nothing to compare against later, and "is it still on" has no answer.
   */
  function planDay() {
    if (!profile || !selectedDate) return;
    if (plan && plan.date === selectedDate && plan.profile === profile.key) {
      setPlan(null);
      writeStorage(PLAN_KEY, '');
      return;
    }
    const now = planReading(tableData, selectedDate, profile);
    const next: Plan = { date: selectedDate, profile: profile.key, setAt: Date.now(), ...now };
    setPlan(next);
    writeStorage(PLAN_KEY, JSON.stringify({ ...next, limits: profile.limits, label: profile.label }));
  }

  function chooseProfile(key: string) {
    const next = profileKey === key ? '' : key;
    setProfileKey(next);
    writeStorage(PROFILE_KEY, next);
  }
  function jumpToWindow(spell: Spell) {
    const date = tableData?.hourly?.time?.[spell.start]?.slice(0, 10);
    const target = date ? days.indexOf(date) : -1;
    if (target >= 0) setSelectedDay(target);
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
              {currentForce && <small className="beaufort">F{currentForce.force} · {currentForce.name}</small>}
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
        </nav>

        <section className="days-strip">
          {days.map((day, index) => {
            const label = dayLabel(day);
            const stats = dayStats[index];
            return (
              <button
                type="button"
                className={`lead-${confidenceAt(index).className}${dayIndex === index ? ' active' : ''}`}
                aria-pressed={dayIndex === index}
                title={`${confidenceAt(index).label} — ${confidenceAt(index).detail}`}
                key={day}
                onClick={() => setSelectedDay(index)}
              >
                <b>{label.dow}</b>
                <span>{label.date}</span>
                <i>{stats.low === null || stats.high === null ? '—' : `${Math.round(stats.low)}–${Math.round(stats.high)}°`}</i>
                <em>{stats.wind === null ? `D+${index}` : `${Math.round(stats.wind)} kt`}</em>
                {profile && matchesPerDay[index] > 0 && <u>{matchesPerDay[index]} h</u>}
              </button>
            );
          })}
        </section>

        {planProfile && plan && (() => {
          const now = planReading(tableData, plan.date, planProfile);
          const drop = plan.hours - now.hours;
          const state = now.hours === 0 ? 'off' : drop >= 2 ? 'worse' : drop <= -2 ? 'better' : 'holding';
          const moved = (was: number | null, is: number | null, digits: number, unit: string) =>
            (was === null || is === null || Math.abs(was - is) < (digits ? 0.05 : 0.5)
              ? null
              : `${unit} ${was.toFixed(digits)} → ${is.toFixed(digits)}`);
          const changes = clauses(
            moved(plan.wave, now.wave, 1, 'sea'),
            moved(plan.wind, now.wind, 0, 'wind'),
          );
          const agreement = agreementOn(tableData, plan.date);
          return (
            <section className={`plan-card ${state}`}>
              <p className="plan-head">
                PLANNED · {planProfile.label.toUpperCase()} · {dayLabel(plan.date).dow} {dayLabel(plan.date).date}
              </p>
              <strong>
                {state === 'off' ? 'No longer suits' : state === 'worse' ? 'Getting worse' : state === 'better' ? 'Improving' : 'Still on'}
                {now.hours > 0 && <span> · {now.hours} h</span>}
              </strong>
              <small>
                {clauses(
                  now.wave === null ? null : `sea ${now.wave.toFixed(1)} m`,
                  now.wind === null ? null : `${now.wind.toFixed(0)} kt`,
                ) || 'no readings yet'}
              </small>
              {changes && <small className="plan-change">since {dayLabel(new Date(plan.setAt).toISOString().slice(0, 10)).dow}: {changes}</small>}
              {agreement.split && (
                <small className="plan-split">
                  models split on {clauses(
                    agreement.wave !== null && agreement.wave >= SPLIT_WAVE_M ? `sea by ${agreement.wave.toFixed(1)} m` : null,
                    agreement.wind !== null && agreement.wind >= SPLIT_WIND_KT ? `wind by ${agreement.wind.toFixed(0)} kt` : null,
                  )} — look again nearer the day
                </small>
              )}
            </section>
          );
        })()}

        <section className="profile-strip" aria-label="Activity">
          {PROFILES.map(entry => (
            <button
              type="button"
              key={entry.key}
              className={profileKey === entry.key ? 'active' : ''}
              aria-pressed={profileKey === entry.key}
              onClick={() => chooseProfile(entry.key)}
            >
              <b>{entry.label}</b><small>{entry.hint}</small>
            </button>
          ))}
          {profile && selectedDate && (
            <button
              type="button"
              className={`plan-button ${plan?.date === selectedDate && plan?.profile === profile.key ? 'on' : ''}`}
              onClick={planDay}
            >
              <b>{plan?.date === selectedDate && plan?.profile === profile.key ? 'Planned' : 'Plan'}</b>
              <small>{dayLabel(selectedDate).dow} {dayLabel(selectedDate).date}</small>
            </button>
          )}
        </section>

        {profile && (spells.length
          ? (
            <div className="window-list">
              <p className="window-caption">Best {profile.label.toLowerCase()} windows</p>
              {spells.map((spell, position) => {
                const date = tableData?.hourly?.time?.[spell.start]?.slice(0, 10);
                const rival = spells[1 - position];
                const mine = profile.pick.of(spell);
                const theirs = rival ? profile.pick.of(rival) : null;
                const isPick = mine !== null && theirs !== null
                  && (profile.pick.best === 'low' ? mine < theirs : mine > theirs);
                return (
                  <button type="button" className="window-banner" key={spell.start} onClick={() => jumpToWindow(spell)}>
                    <strong>
                      {date ? `${dayLabel(date).dow} ` : ''}
                      {formatHour(tableData?.hourly?.time?.[spell.start])}–{formatHour(tableData?.hourly?.time?.[spell.end])}
                    </strong>
                    <b>{spell.hours} h</b>
                    <small>{profile.why(spell)}</small>
                    {isPick && spells.length > 1 && <i>{profile.pick.label}</i>}
                  </button>
                );
              })}
            </div>
          )
          : <p className="notice">No {profile.label} window of {MIN_WINDOW_HOURS} hours or more in the next {days.length} days.</p>
        )}

        <ConditionsGraph data={tableData} indexes={weatherDayIndexes} nowIndex={dataNowIndex} threshold={windAlert} />

        <ReadingTable
          data={tableData}
          columns={tableColumns}
          ensembleDays={ensembleDays}
          focusDate={selectedDate}
          nowIndex={nowIndexFor(tableData)}
          rows={tableRows}
          eyebrow={leadNote}
          eyebrowTone={confidence.className}
          eyebrowTitle={confidence.detail}
          title={`${days.length} days · every 3 hours`}
          badge={activeModel === 'MEAN' ? 'MODEL MEAN' : modelSubject}
          subject={modelSubject}
          footnote={{ group: 'SEA', text: 'Sea rows come from the wave model and do not change with the selected weather model.' }}
          action={
            <button type="button" className={`table-toggle ${compareModels ? 'on' : ''}`} aria-pressed={compareModels} onClick={() => setCompareModels(!compareModels)}>
              {compareModels ? 'Hide models' : 'Compare models'}
            </button>
          }
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

      {activeView === 'Map' && <MapView location={location} />}
      {activeView === 'Saved' && <SavedView favorites={favorites} onSelect={selectLocation} onGps={requestGps} onRemove={removeFavorite} gpsError={gpsError} />}

      <nav className="bottom-nav" aria-label="Main navigation">
        {(['Forecast', 'Map', 'Saved'] as ViewKey[]).map(view => (
          <button type="button" key={view} className={activeView === view ? 'selected' : ''} aria-current={activeView === view ? 'page' : undefined} onClick={() => setActiveView(view)}>
            <span aria-hidden="true">{view === 'Forecast' ? '☼' : view === 'Map' ? '⌖' : '☆'}</span>{view}
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

/**
 * `tier` is what makes the table scannable. Everything used to carry the same
 * visual weight, so there was nowhere for the eye to land. Now the readings a
 * session turns on are set loud, the supporting ones normal, and the reference
 * ones recede — the numbers are all still there, they just stop competing.
 */
type Tier = 'lead' | 'normal' | 'reference';
/** The columns either side, so a spectrum row can blend across cell edges. */
type Neighbours = { before: number | null; after: number | null };
type Row = { key: string; group: string; label: string; unit: string; tier: Tier; render: (data: Forecast | null, index: number, near: Neighbours) => ReactNode };

const EMPTY_CELL = <span className="table-empty">—</span>;
function numberCell(data: Forecast | null, key: string, index: number, format: (value: number) => ReactNode) {
  const value = reading(data, key, index);
  return value === null ? EMPTY_CELL : format(value);
}
/**
 * A spectrum cell: the fill runs edge to edge, and each half fades towards the
 * neighbouring column's colour, so a row reads as one continuous gradient across
 * the day rather than a line of separate swatches. This is the single change
 * that makes a wall of numbers scannable.
 */
function spectrumCell(
  data: Forecast | null,
  key: string,
  index: number,
  near: Neighbours,
  tone: (value: number) => { fill: string; ink: string },
  format: (value: number) => string,
) {
  return numberCell(data, key, index, value => {
    const here = tone(value);
    const edge = (at: number | null) => {
      const neighbour = at === null ? null : reading(data, key, at);
      return neighbour === null ? here.fill : mixHex(here.fill, tone(neighbour).fill);
    };
    return (
      <span
        className="scale-fill"
        style={{
          background: `linear-gradient(90deg, ${edge(near.before)} 0%, ${here.fill} 45%, ${here.fill} 55%, ${edge(near.after)} 100%)`,
          color: here.ink,
        }}
      >
        {format(value)}
      </span>
    );
  });
}
function windCell(data: Forecast | null, key: string, index: number, near: Neighbours) {
  return spectrumCell(data, key, index, near, windTone, value => value.toFixed(1));
}
function arrowCell(data: Forecast | null, key: string, index: number) {
  return numberCell(data, key, index, value => <span className="table-arrow" style={{ transform: `rotate(${value}deg)` }}>↑</span>);
}
/**
 * The day's shape for one row, beside its label. Reading eight numbers to work
 * out whether something is rising or falling is the slow part of a table; this
 * answers it before the numbers are read at all.
 *
 * Scaled to the row's own range, so it shows shape, not magnitude — the numbers
 * carry magnitude.
 */
function Sparkline({ data, seriesKey, indexes, tier }: { data: Forecast | null; seriesKey: string; indexes: number[]; tier: Tier }) {
  const values = indexes.map(index => reading(data, seriesKey, index));
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 3) return null;
  const low = Math.min(...known);
  const span = Math.max(...known) - low || 1;
  const points = values
    .map((value, position) => (value === null
      ? null
      : `${(1 + (position / Math.max(1, values.length - 1)) * 38).toFixed(1)},${(12.5 - ((value - low) / span) * 11).toFixed(1)}`))
    .filter((value): value is string => value !== null);
  if (points.length < 3) return null;
  return (
    <svg className={`sparkline ${tier}`} viewBox="0 0 40 14" aria-hidden="true" focusable="false">
      <polyline points={points.join(' ')} fill="none" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function anyOffshore(data: Forecast | null, indexes: number[]) {
  return indexes.some(index => reading(data, OFFSHORE_KEY, index) === 1);
}

const WEATHER_ROWS: Row[] = [
  {
    key: 'wind_direction_10m',
    group: 'AIR',
    label: 'Direction',
    unit: '',
    tier: 'lead',
    render: (data, index) => numberCell(data, 'wind_direction_10m', index, value => (
      <span className={`dir-cell${reading(data, OFFSHORE_KEY, index) === 1 ? ' offshore' : ''}`}>
        <span className="table-arrow" style={{ transform: `rotate(${value}deg)` }}>↑</span>
      </span>
    )),
  },
  { key: 'wind_speed_10m', group: 'AIR', label: 'Wind', unit: 'kt', tier: 'lead', render: (data, index, near) => windCell(data, 'wind_speed_10m', index, near) },
  { key: 'wind_gusts_10m', group: 'AIR', label: 'Gusts', unit: 'kt', tier: 'lead', render: (data, index, near) => windCell(data, 'wind_gusts_10m', index, near) },
  {
    key: 'temperature_2m',
    group: 'AIR',
    label: 'Temperature',
    unit: '°C',
    tier: 'normal',
    render: (data, index, near) => spectrumCell(data, 'temperature_2m', index, near, tempTone, value => `${Math.round(value)}°`),
  },
  { key: 'pressure_msl', group: 'AIR', label: 'Pressure', unit: 'hPa', tier: 'reference', render: (data, index) => numberCell(data, 'pressure_msl', index, value => Math.round(value)) },
  {
    key: 'precipitation',
    group: 'AIR',
    label: 'Rain',
    unit: 'mm',
    tier: 'normal',
    /*
     * Eight cells reading "0.0" is not information, it is filler that the eye
     * skips — which is why this row may as well not have been here on a dry day.
     * A dry hour is now an empty drop and nothing else; a wet one fills in and
     * states the amount, with the tint scaled to how much.
     */
    render: (data, index) => numberCell(data, 'precipitation', index, value => (value < 0.05
      ? <span className="rain-cell dry" aria-label="no rain">◌</span>
      : (
        <span className="rain-cell wet" style={{ '--wet': `${Math.min(100, value * 45).toFixed(0)}%` } as CSSProperties}>
          <b>{value.toFixed(1)}</b>
        </span>
      ))),
  },
  {
    key: 'cloud_cover',
    group: 'AIR',
    label: 'Clouds',
    unit: '%',
    tier: 'reference',
    // A filled disc rather than a percentage: nobody reads "38" as a sky.
    render: (data, index) => numberCell(data, 'cloud_cover', index, value => (
      <span className="cloud-dial" style={{ '--cover': `${Math.round(value)}%` } as CSSProperties} aria-label={`${Math.round(value)} percent cloud`} />
    )),
  },
];

// Shown only for the mean: a mean is worth no more than the agreement behind
// it, so the spread and the number of contributing models sit in the table.
const AGREEMENT_ROWS: Row[] = [
  {
    key: 'wind_speed_10m' + SPREAD_SUFFIX,
    group: 'MODEL AGREEMENT',
    label: 'Wind spread',
    unit: 'kt',
    tier: 'normal',
    render: (data, index) => numberCell(data, 'wind_speed_10m' + SPREAD_SUFFIX, index,
      value => <span className={`agreement ${value < 3 ? 'good' : value < 6 ? 'fair' : 'poor'}`}>{value.toFixed(1)}</span>),
  },
  {
    key: 'wind_speed_10m' + COUNT_SUFFIX,
    group: 'MODEL AGREEMENT',
    label: 'Models used',
    unit: `of ${MODEL_KEYS.length}`,
    tier: 'reference',
    render: (data, index) => numberCell(data, 'wind_speed_10m' + COUNT_SUFFIX, index, value => String(value)),
  },
];


const MARINE_ROWS: Row[] = [
  { key: 'wave_direction', group: 'SEA', label: 'Direction', unit: '', tier: 'normal', render: (data, index) => arrowCell(data, 'wave_direction', index) },
  {
    key: 'wave_height',
    group: 'SEA',
    label: 'Waves',
    unit: 'm',
    tier: 'lead',
    render: (data, index, near) => spectrumCell(data, 'wave_height', index, near, waveTone, value => value.toFixed(1)),
  },
  { key: 'wave_period', group: 'SEA', label: 'Period', unit: 's', tier: 'lead', render: (data, index) => numberCell(data, 'wave_period', index, value => value.toFixed(0)) },
  { key: 'sea_surface_temperature', group: 'SEA', label: 'Water', unit: '°C', tier: 'normal', render: (data, index, near) => spectrumCell(data, 'sea_surface_temperature', index, near, tempTone, value => `${Math.round(value)}°`) },
  { key: 'swell_wave_height', group: 'SEA', label: 'Swell', unit: 'm', tier: 'normal', render: (data, index, near) => spectrumCell(data, 'swell_wave_height', index, near, waveTone, value => value.toFixed(1)) },
  { key: 'swell_wave_period', group: 'SEA', label: 'Swell period', unit: 's', tier: 'normal', render: (data, index) => numberCell(data, 'swell_wave_period', index, value => value.toFixed(0)) },
  {
    key: 'wind_wave_height',
    group: 'SEA',
    label: 'Wind wave',
    unit: 'm',
    tier: 'normal',
    // The same ramp as the swell row above it on purpose: the two are only
    // worth reading against each other, and they cannot be compared by eye if
    // one is painted and the other is a bare number. A green swell over a red
    // wind wave is chop; the other way round is a session.
    render: (data, index, near) => spectrumCell(data, 'wind_wave_height', index, near, waveTone, value => value.toFixed(1)),
  },
  {
    key: 'wave_height' + SPREAD_SUFFIX,
    group: 'SEA',
    label: 'Model split',
    unit: 'm',
    tier: 'reference',
    /*
     * How far apart the wave models were at that hour. Until this release the
     * sea came from one model and this row could not have existed; the number
     * shown above is now their mean, and this says how much of an agreement
     * that mean represents.
     */
    render: (data, index) => numberCell(data, 'wave_height' + SPREAD_SUFFIX, index, value => value.toFixed(2)),
  },
  { key: 'ocean_current_velocity', group: 'SEA', label: 'Current', unit: 'km/h', tier: 'reference', render: (data, index) => numberCell(data, 'ocean_current_velocity', index, value => value.toFixed(2)) },
  { key: 'sea_level_height_msl', group: 'SEA', label: 'Sea level', unit: 'm', tier: 'reference', render: (data, index) => numberCell(data, 'sea_level_height_msl', index, value => value.toFixed(2)) },
];

const MODEL_WIND_ROWS: Row[] = MODEL_KEYS.map(model => ({
  key: `${MODEL_ROW_PREFIX}${model}:wind_speed_10m`,
  group: 'MODELS · WIND',
  label: model,
  unit: MODEL_META[model].provider,
  tier: 'normal',
  render: (data, index, near) => windCell(data, `${MODEL_ROW_PREFIX}${model}:wind_speed_10m`, index, near),
}));

const GRAPH = { width: 320, left: 30, right: 10, arrowY: 13, windTop: 24, windHeight: 84, waveTop: 130, waveHeight: 40, tideTop: 182, tideHeight: 30 };

function niceCeiling(value: number, step: number, floor: number) {
  return Math.max(floor, Math.ceil(value / step) * step);
}

/**
 * Wind and waves for the selected day, hour by hour.
 *
 * Wind is bars rather than a curve: a bar carries its own colour, and colour is
 * how strength is read everywhere else in this app. A thin line at this size
 * carries neither well. Above them sits the reading the table buries and the sea
 * decides everything by — direction — with offshore hours marked, so the whole
 * question of whether a session is on can be answered without reading a number.
 *
 * Waves get their own strip below rather than a second line in the same box:
 * knots and metres are different scales and sharing an axis makes both unreadable.
 * The table below remains the accessible numeric equivalent.
 */
function ConditionsGraph({ data, indexes, nowIndex, threshold }: {
  data: Forecast | null;
  indexes: number[];
  nowIndex: number;
  threshold: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const points = indexes
    .map(index => ({
      index,
      time: data?.hourly?.time?.[index],
      wind: reading(data, 'wind_speed_10m', index),
      direction: reading(data, 'wind_direction_10m', index),
      wave: reading(data, 'wave_height', index),
      period: reading(data, 'wave_period', index),
      tide: reading(data, 'sea_level_height_msl', index),
      offshore: reading(data, OFFSHORE_KEY, index) === 1,
      night: reading(data, 'is_day', index) === 0,
    }))
    .filter(point => point.wind !== null);
  if (points.length < 2) return null;

  const hasWave = points.some(point => point.wave !== null);
  const tideValues = points.map(point => point.tide).filter((value): value is number => value !== null);
  const hasTide = tideValues.length > 3;
  const height = hasTide ? 230 : hasWave ? 190 : 132;
  const labelY = height - 8;
  const plotWidth = GRAPH.width - GRAPH.left - GRAPH.right;
  const slot = plotWidth / points.length;
  const barWidth = Math.max(2, slot - 2);
  const centre = (position: number) => GRAPH.left + position * slot + slot / 2;

  const windCeiling = niceCeiling(Math.max(...points.map(point => point.wind ?? 0), threshold), 5, 10);
  const waveCeiling = niceCeiling(Math.max(...points.map(point => point.wave ?? 0)), 0.5, 1);
  const windBase = GRAPH.windTop + GRAPH.windHeight;
  const yWind = (value: number) => windBase - (value / windCeiling) * GRAPH.windHeight;

  /**
   * Waves are bars in their own blue spectrum, built exactly like the wind bars
   * above them.
   *
   * A drawn sea surface was tried first and read as decoration: pretty, but you
   * could not tell which hour was bigger. Two panels that share a shape share a
   * way of being read, and the only thing that has to differ between them is
   * what the colour means — green to red for wind, blue for sea, so a glance
   * never confuses the two.
   */
  const waveBase = GRAPH.waveTop + GRAPH.waveHeight;
  const yWave = (value: number) => waveBase - (value / waveCeiling) * GRAPH.waveHeight;
  const typicalPeriod = (() => {
    const periods = points.map(point => point.period).filter((v): v is number => v !== null);
    return periods.length ? periods.reduce((sum, v) => sum + v, 0) / periods.length : null;
  })();

  /**
   * Tide, drawn to its own range rather than a fixed scale. A twenty-centimetre
   * Mediterranean swing and a four-metre Atlantic one are both the whole story
   * where they happen, and the numbers on the marks carry the absolute size.
   */
  const tideLow = hasTide ? Math.min(...tideValues) : 0;
  const tideSpan = hasTide ? Math.max(...tideValues) - tideLow || 1 : 1;
  const yTide = (value: number) => GRAPH.tideTop + GRAPH.tideHeight - ((value - tideLow) / tideSpan) * GRAPH.tideHeight;
  const tidePath = hasTide
    ? points
      .map((point, position) => (point.tide === null ? null : `${position === 0 ? 'M' : 'L'}${centre(position).toFixed(1)},${yTide(point.tide).toFixed(1)}`))
      .filter(Boolean)
      .join(' ')
    : '';
  const tideMarks = hasTide
    ? points
      .map((point, position) => ({ point, position }))
      .filter(({ point, position }) => {
        const before = points[position - 1]?.tide;
        const after = points[position + 1]?.tide;
        if (point.tide === null || before === null || after === null || before === undefined || after === undefined) return false;
        return (point.tide > before && point.tide >= after) || (point.tide < before && point.tide <= after);
      })
    : [];

  const peakWind = points.reduce((best, point) => ((point.wind ?? 0) > (best.wind ?? 0) ? point : best), points[0]);
  const peakWave = Math.max(...points.map(point => point.wave ?? 0));
  const active = hover === null ? null : points[hover];
  const nowAt = points.findIndex(point => point.index === nowIndex);
  const bottom = hasTide
    ? GRAPH.tideTop + GRAPH.tideHeight
    : hasWave ? GRAPH.waveTop + GRAPH.waveHeight : windBase;
  const arrowEvery = Math.max(1, Math.round(points.length / 8));

  const onPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = ((event.clientX - box.left) / box.width) * GRAPH.width;
    setHover(Math.max(0, Math.min(points.length - 1, Math.floor((ratio - GRAPH.left) / slot))));
  };

  return (
    <section className="graph-card">
      <div className="section-title">
        <div>
          <p className="eyebrow">THROUGH THE DAY</p>
          <h2>Wind to {fixed(peakWind.wind, 0)} kt</h2>
          {hasWave && (
            <p className="graph-sub">Sea {peakWave.toFixed(1)} m{typicalPeriod ? ` at ${typicalPeriod.toFixed(0)} s` : ''}</p>
          )}
        </div>
        <div className="graph-legend">
          {/* No unit: the same ramp now serves both panels on their own scales. */}
          <span className="ramp-legend">
            <b>calm</b>
            {SEVERITY.map(band => <i key={band.fill} style={{ background: band.fill }} />)}
            <b>rough</b>
          </span>
        </div>
      </div>
      <div className="graph-frame">
        <svg
          viewBox={`0 0 ${GRAPH.width} ${height}`}
          role="img"
          aria-label={`Wind and waves through the day. Wind peaks at ${fixed(peakWind.wind, 0)} knots${hasWave ? `, waves at ${peakWave.toFixed(1)} metres` : ''}. The table below carries the same readings.`}
          onPointerMove={onPointer}
          onPointerLeave={() => setHover(null)}
        >
          {points.map((point, position) => point.night && (
            <rect key={point.index} x={GRAPH.left + position * slot} y={GRAPH.windTop} width={slot} height={bottom - GRAPH.windTop} fill="#0a1c25" />
          ))}

          <line x1={GRAPH.left} x2={GRAPH.width - GRAPH.right} y1={yWind(windCeiling)} y2={yWind(windCeiling)} stroke="#24414d" strokeWidth="1" />
          <text x={GRAPH.left - 5} y={yWind(windCeiling) + 3} textAnchor="end" fill="#89a0aa" fontSize="9">{windCeiling}</text>
          <text x={GRAPH.left - 5} y={windBase + 3} textAnchor="end" fill="#89a0aa" fontSize="9">0</text>

          {points.map((point, position) => {
            const tone = windTone(point.wind ?? 0);
            const top = yWind(point.wind ?? 0);
            return (
              <rect
                key={point.index}
                x={GRAPH.left + position * slot + 1}
                y={top}
                width={barWidth}
                height={Math.max(1, windBase - top)}
                rx="1.5"
                fill={tone.fill}
              />
            );
          })}

          <line x1={GRAPH.left} x2={GRAPH.width - GRAPH.right} y1={yWind(threshold)} y2={yWind(threshold)} stroke="#edf6f7" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.65" />
          <text x={GRAPH.width - GRAPH.right} y={yWind(threshold) - 3} textAnchor="end" fill="#c3d3d9" fontSize="9">alert {threshold}</text>

          {hasTide && <>
            <path d={tidePath} fill="none" stroke="#4aa596" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
            {tideMarks.map(({ point, position }) => (
              <g key={point.index}>
                <circle cx={centre(position)} cy={yTide(point.tide ?? 0)} r="2" fill="#4aa596" />
                {/* Always above the dot: hung below, a low-tide label lands on the hour axis. */}
                <text x={centre(position)} y={yTide(point.tide ?? 0) - 5} textAnchor="middle" fill="#8fb0bc" fontSize="8">
                  {formatHour(point.time)}
                </text>
              </g>
            ))}
            <text x={GRAPH.left - 5} y={GRAPH.tideTop + GRAPH.tideHeight * 0.6} textAnchor="end" fill="#5f7681" fontSize="9">tide</text>
          </>}

          {points.map((point, position) => (position % arrowEvery === 0 && point.direction !== null) && (
            <path
              key={point.index}
              d="M0,-3.8 L2.5,3.2 L0,1.5 L-2.5,3.2 Z"
              fill={point.offshore ? '#db7548' : '#9fb6bf'}
              transform={`translate(${centre(position).toFixed(1)},${GRAPH.arrowY}) rotate(${point.direction})`}
            />
          ))}

          {hasWave && <>
            {points.map((point, position) => point.wave !== null && (
              <rect
                key={point.index}
                x={GRAPH.left + position * slot + 1}
                y={yWave(point.wave)}
                width={barWidth}
                height={Math.max(1, waveBase - yWave(point.wave))}
                rx="1.5"
                fill={waveTone(point.wave).fill}
              />
            ))}
            <text x={GRAPH.left - 5} y={GRAPH.waveTop + 8} textAnchor="end" fill="#89a0aa" fontSize="9">{waveCeiling.toFixed(1)}</text>
            <text x={GRAPH.left - 5} y={waveBase + 3} textAnchor="end" fill="#5f7681" fontSize="9">m</text>
          </>}

          {/* No forced label on the last hour: next to the regular one it collides. */}
          {points.map((point, position) => position % arrowEvery === 0 && (
            <text key={point.index} x={centre(position)} y={labelY} textAnchor="middle" fill="#89a0aa" fontSize="9">{formatHour(point.time)}</text>
          ))}

          {nowAt >= 0 && <line x1={centre(nowAt)} x2={centre(nowAt)} y1={GRAPH.windTop} y2={bottom} stroke="#38e3b1" strokeWidth="1.5" />}
          {active && <line x1={centre(hover ?? 0)} x2={centre(hover ?? 0)} y1={GRAPH.windTop} y2={bottom} stroke="#edf6f7" strokeWidth="1" strokeOpacity="0.55" />}
        </svg>
        {active && (
          <p className="graph-tooltip">
            <b>{formatHour(active.time)}</b> {fixed(active.wind, 1)} kt {cardinal(active.direction)}
            {active.wave !== null && <> · {active.wave.toFixed(1)} m{active.period !== null ? ` @ ${active.period.toFixed(0)} s` : ''}</>}
            {active.tide !== null && <> · tide {active.tide.toFixed(2)} m</>}
            {active.offshore && <em> offshore</em>}
          </p>
        )}
      </div>
    </section>
  );
}

// The column count travels to the grid as a custom property rather than a full
// grid-template-columns value, so the responsive rules in the stylesheet still
// win over the inline style.
/**
 * One table for the whole range.
 *
 * Days used to be a filter: pick one, see eight columns. Reading Friday against
 * Saturday meant tapping between them and holding the numbers in your head. Now
 * the days run on, separated by a rule and headed by their date, and the day
 * strip above scrolls here instead of swapping the contents.
 *
 * That makes the header the load-bearing part: scrolled anywhere but the top
 * left, a column of numbers says neither which hour nor which day it is. So the
 * table is its own scroll box with the date and hour rows pinned to the top and
 * the labels pinned to the left.
 */
function ReadingTable({ data, columns, ensembleDays, focusDate, nowIndex, rows: candidates, badge, eyebrow, eyebrowTone, eyebrowTitle, title, subject, footnote, action }: {
  data: Forecast | null;
  columns: { index: number; date: string }[];
  ensembleDays: Set<string>;
  focusDate?: string;
  nowIndex: number;
  rows: Row[];
  badge: string;
  eyebrow: string;
  eyebrowTone?: string;
  eyebrowTitle?: string;
  title: string;
  subject: string;
  footnote?: { group: string; text: string };
  action?: ReactNode;
}) {
  const header = useRef<HTMLDivElement | null>(null);
  const headerGrid = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const indexes = useMemo(() => columns.map(column => column.index), [columns]);

  /**
   * The dates and hours live in their own strip, scrolled sideways in step with
   * the body below it.
   *
   * They used to share one box that scrolled both ways, which is what let the
   * header stay put — and it also swallowed the page. A finger anywhere over the
   * table drove the table's own scroll instead of the page, so you could not get
   * back up, and reaching the table before it filled the screen left you reading
   * a quarter-height grid. With the vertical scroll gone the page behaves
   * normally and the strip pins to the top of the viewport instead.
   */
  /**
   * Only the body scrolls; the header strip is shifted to match.
   *
   * Two scrollers syncing each other's scrollLeft is the obvious approach and a
   * poor one: each write fires the other's scroll event, so it needs a guard
   * flag, and a dropped frame leaves the two out of step. One scroller and a
   * transform cannot desynchronise, and it never re-renders — the transform is
   * written straight to the node.
   */
  const followHeader = (left: number) => {
    const grid = headerGrid.current;
    if (grid) grid.style.transform = `translateX(${-left}px)`;
  };
  const onBodyScroll = (event: React.UIEvent<HTMLDivElement>) => followHeader(event.currentTarget.scrollLeft);

  /**
   * Measured from the boxes themselves rather than offsetLeft: the day headers
   * are sticky, so their offsetParent is not the scroll box and offsetLeft
   * answers a different question than the one being asked.
   *
   * The jump is instant. `behavior: 'smooth'` was silently doing nothing here,
   * which is also what it does for anyone who has asked for reduced motion —
   * a jump that only sometimes happens is worse than one that always does.
   */
  useEffect(() => {
    const box = scroller.current;
    if (!box || !focusDate) return;
    const target = header.current?.querySelector<HTMLElement>(`[data-day-start="${focusDate}"]`);
    if (!target) return;
    const label = box.querySelector<HTMLElement>('.table-label');
    const gutter = label ? label.getBoundingClientRect().width : 0;
    const delta = target.getBoundingClientRect().left - box.getBoundingClientRect().left - gutter;
    const left = Math.max(0, box.scrollLeft + delta);
    box.scrollLeft = left;
    followHeader(left);
  }, [focusDate]);

  const night = new Set(indexes.filter(index => reading(data, 'is_day', index) === 0));
  const rows = candidates.filter(row => hasVisibleData(data, row.key, indexes));
  const missing = candidates.filter(row => !rows.includes(row));
  const missingCopy = [...new Set(missing.map(row => row.group))].map(group => {
    const absent = missing.filter(row => row.group === group);
    return absent.length === candidates.filter(row => row.group === group).length
      ? `no ${group.toLowerCase()} data`
      : `no ${absent.map(row => row.label.toLowerCase()).join(', ')}`;
  });

  // Runs of columns belonging to the same day, for the spanning date header.
  const spans: { date: string; from: number; count: number }[] = [];
  columns.forEach((column, position) => {
    const last = spans[spans.length - 1];
    if (last && last.date === column.date) last.count += 1;
    else spans.push({ date: column.date, from: position, count: 1 });
  });

  const current = indexes.includes(nowIndex)
    ? nowIndex
    : indexes.reduce<number | null>((best, index) => (
      index <= nowIndex && (best === null || index > best) ? index : best), null);

  return (
    <section className="forecast-card">
      <div className="section-title">
        <div><p className={`eyebrow${eyebrowTone ? ` lead-${eyebrowTone}` : ''}`} title={eyebrowTitle}>{eyebrow}</p><h2>{title}</h2></div>
        <div className="section-actions">{action}<span className="live-badge">{badge}</span></div>
      </div>
      {rows.length && columns.length ? (
        <>
        <div className="table-head-strip" ref={header}>
          <div className="table-grid" ref={headerGrid} style={{ '--cols': columns.length } as CSSProperties}>
            <div className="table-day table-label corner"><b>DATE</b></div>
            {spans.map(span => {
              const label = dayLabel(span.date);
              return (
                <div
                  className={`table-day${span.from === 0 ? '' : ' day-start'}`}
                  data-day-start={span.date}
                  style={{ gridColumn: `span ${span.count}` }}
                  key={span.date}
                >
                  {/* Pinned inside its own span, so the date stays put while you
                      scroll through that day's hours rather than sliding away. */}
                  <span className="day-name">
                    <b>{label.dow}</b> {label.date}
                    {ensembleDays.has(span.date) && <i title="NOAA GEFS ensemble mean">ENS</i>}
                  </span>
                </div>
              );
            })}

            <div className="table-head table-label corner"><b>LOCAL TIME</b></div>
            {columns.map((column, position) => (
              <div
                className={`table-head${night.has(column.index) ? ' night' : ''}${column.index === current ? ' current' : ''}${reading(data, MATCH_KEY, column.index) === 1 ? ' suits' : ''}${spans.some(span => span.from === position && position > 0) ? ' day-start' : ''}`}
                key={column.index}
              >
                {formatHour(data?.hourly?.time?.[column.index])}
                {night.has(column.index) && <em aria-label="after dark">☾</em>}
              </div>
            ))}
          </div>
        </div>
        <div className="table-body" ref={scroller} onScroll={onBodyScroll}>
          <div className="table-grid" style={{ '--cols': columns.length } as CSSProperties}>
            {rows.map((row, rowPosition) => (
              <Fragment key={row.key}>
                {row.group !== rows[rowPosition - 1]?.group && <>
                  <div className="table-group table-label"><span>{row.group}</span></div>
                  {columns.map(column => <div className="table-group-fill" key={column.index} />)}
                </>}
                <div className="table-row">
                  <div className={`table-label ${row.tier}`}>
                    <span className="label-text"><b>{row.label}</b><small>{row.unit}</small></span>
                    <Sparkline data={data} seriesKey={row.key} indexes={indexes} tier={row.tier} />
                  </div>
                  {columns.map((column, position) => (
                    <div
                      className={`table-cell ${row.tier}${night.has(column.index) ? ' night' : ''}${column.index === current ? ' current' : ''}${spans.some(span => span.from === position && position > 0) ? ' day-start' : ''}`}
                      key={column.index}
                    >
                      {row.render(data, column.index, {
                        before: position > 0 ? columns[position - 1].index : null,
                        after: position < columns.length - 1 ? columns[position + 1].index : null,
                      })}
                    </div>
                  ))}
                </div>
              </Fragment>
            ))}
          </div>
        </div>
        </>
      ) : (
        <p className="notice">{subject} publishes no data for this range.</p>
      )}
      {rows.length > 0 && missingCopy.length > 0 && (
        <p className="data-note">Across this range: {missingCopy.join('; ')}.</p>
      )}
      {rows.length > 0 && anyOffshore(data, indexes) && (
        <p className="data-note offshore-note">
          <span className="offshore-dot" aria-hidden="true" />
          Offshore — the wind is blowing from the shore out to sea.
        </p>
      )}
      {footnote && rows.some(row => row.group === footnote.group) && (
        <p className="data-note">{footnote.text}</p>
      )}
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
