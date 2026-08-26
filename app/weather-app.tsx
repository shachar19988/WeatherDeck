'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Location = { name: string; country: string; latitude: number; longitude: number };
type Hourly = { time: string[]; [key: string]: string[] | number[] };
type Forecast = { hourly: Hourly; hourly_units: Record<string, string>; generationtime_ms: number };
type ModelKey = 'ECMWF' | 'GFS' | 'ICON' | 'AIFS';
type ViewKey = 'Forecast' | 'Compare' | 'Marine' | 'Map' | 'Saved';

const MODEL_IDS: Record<ModelKey, string> = {
  ECMWF: 'ecmwf_ifs', GFS: 'gfs_seamless', ICON: 'icon_global', AIFS: 'ecmwf_aifs025_single',
};
const MODEL_META: Record<ModelKey, { provider: string; resolution: string }> = {
  ECMWF: { provider: 'European Centre', resolution: '9 km' },
  GFS: { provider: 'NOAA', resolution: '11–25 km' },
  ICON: { provider: 'DWD', resolution: '11 km' },
  AIFS: { provider: 'ECMWF AI', resolution: '25 km' },
};
const DEFAULT_LOCATION: Location = { name: 'Haifa', country: 'Israel', latitude: 32.794, longitude: 34.9896 };
const WEATHER_VARS = 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cape';
const LONG_RANGE_VARS = 'temperature_2m,temperature_2m_spread,relative_humidity_2m,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_speed_10m_spread,wind_direction_10m,wind_gusts_10m';
const MARINE_VARS = 'wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,ocean_current_velocity,ocean_current_direction,sea_level_height_msl';

function value(data: Forecast | null, key: string, index: number, fallback = 0) {
  const series = data?.hourly?.[key] as number[] | undefined;
  return Number(series?.[index] ?? fallback);
}
function maybeValue(data: Forecast | null, key: string, index: number) {
  const series = data?.hourly?.[key] as number[] | undefined;
  const raw = series?.[index];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}
function indexesForDate(data: Forecast | null, date?: string) {
  if (!date) return [];
  return (data?.hourly?.time || []).map((time,index)=>time.startsWith(date)?index:-1).filter(index=>index>=0);
}
function maximumReading(data: Forecast | null, key: string, indexes: number[]) {
  let bestValue = Number.NEGATIVE_INFINITY;
  let bestIndex = -1;
  for (const index of indexes) {
    const reading = maybeValue(data,key,index);
    if (reading !== null && reading > bestValue) { bestValue = reading; bestIndex = index; }
  }
  return bestIndex >= 0 ? { value:bestValue, index:bestIndex } : null;
}
function cardinal(deg: number) {
  const labels = ['N','NE','E','SE','S','SW','W','NW'];
  return labels[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
function weatherLabel(cloud: number, rain: number) {
  if (rain > 2) return 'Rain';
  if (rain > 0) return 'Light rain';
  if (cloud > 75) return 'Overcast';
  if (cloud > 35) return 'Partly cloudy';
  return 'Clear';
}
function formatHour(iso: string) { return iso?.slice(11,16) || '--:--'; }
function dayLabel(iso: string) {
  const d = new Date(iso);
  return { dow: d.toLocaleDateString('en-US',{weekday:'short'}), date: d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) };
}
function cacheKey(location: Location) { return `weatherdeck:${location.latitude.toFixed(2)},${location.longitude.toFixed(2)}`; }

export default function WeatherApp() {
  const [location, setLocation] = useState<Location>(DEFAULT_LOCATION);
  const [activeModel, setActiveModel] = useState<ModelKey>('ECMWF');
  const [activeView, setActiveView] = useState<ViewKey>('Forecast');
  const [forecasts, setForecasts] = useState<Partial<Record<ModelKey, Forecast>>>({});
  const [extended, setExtended] = useState<Forecast | null>(null);
  const [marine, setMarine] = useState<Forecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Location[]>([]);
  const [favorites, setFavorites] = useState<Location[]>([DEFAULT_LOCATION]);
  const [windAlert, setWindAlert] = useState(15);
  const [selectedDay, setSelectedDay] = useState(0);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    navigator.serviceWorker?.register('/sw.js').catch(() => undefined);
    const saved = localStorage.getItem('weatherdeck:favorites');
    if (saved) try { setFavorites(JSON.parse(saved)); } catch { /* ignore */ }
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const loadForecast = useCallback(async () => {
    setLoading(true);
    const base = `latitude=${location.latitude}&longitude=${location.longitude}&hourly=${WEATHER_VARS}&forecast_days=16&timezone=auto&wind_speed_unit=kn`;
    const requests = (Object.keys(MODEL_IDS) as ModelKey[]).map(async key => {
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${base}&models=${MODEL_IDS[key]}`);
      if (!response.ok) throw new Error(key);
      return [key, await response.json() as Forecast] as const;
    });
    const marineRequest = fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${location.latitude}&longitude=${location.longitude}&hourly=${MARINE_VARS}&forecast_days=10&timezone=auto`)
      .then(r => r.ok ? r.json() as Promise<Forecast> : null).catch(() => null);
    const extendedRequest = fetch(`https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${location.latitude}&longitude=${location.longitude}&hourly=${LONG_RANGE_VARS}&forecast_days=21&timezone=auto&wind_speed_unit=kn&models=ncep_gefs05_ensemble_mean`)
      .then(r => r.ok ? r.json() as Promise<Forecast> : null).catch(() => null);
    try {
      const settled = await Promise.allSettled(requests);
      const next: Partial<Record<ModelKey, Forecast>> = {};
      settled.forEach(item => { if (item.status === 'fulfilled') next[item.value[0]] = item.value[1]; });
      const [nextMarine, nextExtended] = await Promise.all([marineRequest, extendedRequest]);
      if (Object.keys(next).length) {
        setForecasts(next); setMarine(nextMarine); setExtended(nextExtended);
        localStorage.setItem(cacheKey(location), JSON.stringify({ forecasts: next, marine: nextMarine, extended: nextExtended, savedAt: Date.now() }));
      } else throw new Error('No model available');
    } catch {
      const cached = localStorage.getItem(cacheKey(location));
      if (cached) { const parsed = JSON.parse(cached); setForecasts(parsed.forecasts); setMarine(parsed.marine); setExtended(parsed.extended || null); }
    } finally { setLoading(false); }
  }, [location]);

  useEffect(() => {
    loadForecast();
    const refresh = window.setInterval(loadForecast, 30 * 60 * 1000);
    const refreshOnFocus = () => loadForecast();
    window.addEventListener('focus', refreshOnFocus);
    return () => { window.clearInterval(refresh); window.removeEventListener('focus', refreshOnFocus); };
  }, [loadForecast]);

  useEffect(() => {
    if (search.trim().length < 2) { setResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(search)}&count=6&language=en&format=json`);
        const json = await r.json() as { results?: Record<string, unknown>[] };
        setResults((json.results || []).map((x: Record<string, unknown>) => ({ name: String(x.name), country: String(x.country || ''), latitude: Number(x.latitude), longitude: Number(x.longitude) })));
      } catch { setResults([]); }
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const current = forecasts[activeModel] || forecasts.ECMWF || null;
  const nowIndex = useMemo(() => {
    const times = current?.hourly?.time || [];
    const now = new Date();
    const idx = times.findIndex(t => new Date(t) >= now);
    return Math.max(0, idx < 0 ? 0 : idx);
  }, [current]);
  const currentTemp = value(current,'temperature_2m',nowIndex,27);
  const currentWind = value(current,'wind_speed_10m',nowIndex,7);
  const currentDir = value(current,'wind_direction_10m',nowIndex,310);
  const currentCloud = value(current,'cloud_cover',nowIndex,10);
  const currentRain = value(current,'precipitation',nowIndex,0);

  const days = useMemo(() => {
    const times = extended?.hourly?.time || current?.hourly?.time || [];
    return Array.from(new Set(times.map(t => t.slice(0,10)))).slice(0,21);
  }, [current,extended]);
  const selectedDate = days[selectedDay];
  const usingExtended = Boolean(selectedDate && extended && !current?.hourly?.time?.some(t => t.startsWith(selectedDate)));
  const forecastData = usingExtended ? extended : current;
  const forecastIndexes = useMemo(() => {
    const date = days[selectedDay];
    const times = forecastData?.hourly?.time || [];
    if (!date) return Array.from({length:8},(_,i)=>nowIndex+i*3);
    const indexes = times.map((t,i)=>t.startsWith(date)?i:-1).filter(i=>i>=0);
    return indexes.filter((_,i)=>i%3===0).slice(0,8);
  }, [forecastData,days,selectedDay,nowIndex]);
  const representativeIndex = forecastIndexes[Math.min(4, forecastIndexes.length - 1)] ?? 0;
  const sourceDetail = usingExtended
    ? `GEFS mean · ±${value(extended,'temperature_2m_spread',representativeIndex).toFixed(1)}°C · wind spread ±${value(extended,'wind_speed_10m_spread',representativeIndex).toFixed(1)} kt`
    : `${activeModel} operational model`;
  const shortIndexes = useMemo(() => Array.from({length:8},(_,i)=>nowIndex+i*3), [nowIndex]);
  const weatherDayIndexes = useMemo(() => indexesForDate(forecastData,selectedDate), [forecastData,selectedDate]);
  const marineDayIndexes = useMemo(() => indexesForDate(marine,selectedDate), [marine,selectedDate]);
  const peakWave = useMemo(() => maximumReading(marine,'wave_height',marineDayIndexes), [marine,marineDayIndexes]);
  const rainChance = useMemo(() => maximumReading(forecastData,'precipitation_probability',weatherDayIndexes), [forecastData,weatherDayIndexes]);
  const peakCape = useMemo(() => maximumReading(forecastData,'cape',weatherDayIndexes), [forecastData,weatherDayIndexes]);
  const dailyRain = useMemo(() => weatherDayIndexes.reduce((sum,index)=>sum+(maybeValue(forecastData,'precipitation',index) || 0),0), [forecastData,weatherDayIndexes]);
  const confidence = selectedDay < 5
    ? { label:'High confidence', className:'high', detail:'Best operational guidance' }
    : selectedDay < 10
      ? { label:'Medium confidence', className:'medium', detail:'Model differences are increasing' }
      : selectedDay < 16
        ? { label:'Low confidence', className:'low', detail:'Use as planning guidance only' }
        : { label:'Very low confidence', className:'very-low', detail:'Experimental long-range trend' };

  function saveFavorite() {
    if (favorites.some(f => f.name === location.name && f.country === location.country)) return;
    const next = [...favorites, location]; setFavorites(next); localStorage.setItem('weatherdeck:favorites', JSON.stringify(next));
  }
  function selectLocation(next: Location) { setLocation(next); setSelectedDay(0); setSearchOpen(false); setSearch(''); }
  function useGps() {
    navigator.geolocation?.getCurrentPosition(pos => selectLocation({ name:'Current location',country:'',latitude:pos.coords.latitude,longitude:pos.coords.longitude }));
  }
  async function enableAlerts() {
    if ('Notification' in window) await Notification.requestPermission();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand-button" onClick={()=>setActiveView('Forecast')} aria-label="WeatherDeck home"><span className="brand-mark">W</span><span><b>WeatherDeck</b><small>Personal forecast console</small></span></button>
        <div className="top-actions"><span className={`connection ${online?'online':'offline'}`}>{online?'LIVE':'OFFLINE'}</span><button className="icon-button" onClick={()=>setSettingsOpen(true)} aria-label="Settings">≡</button></div>
      </header>

      <section className="location-bar">
        <button onClick={()=>setSearchOpen(true)}><span className="pin">⌖</span><span><b>{location.name}</b><small>{location.country || `${location.latitude.toFixed(2)}, ${location.longitude.toFixed(2)}`}</small></span><i>⌄</i></button>
        <button className="round-button" onClick={saveFavorite} aria-label="Save location">☆</button>
      </section>

      {activeView === 'Forecast' && <>
        <section className="hero-card">
          <div className="hero-weather"><p className="muted">{loading?'Updating live forecast…':`${weatherLabel(currentCloud,currentRain)} · Updated just now`}</p><div className="current-reading"><strong>{Math.round(currentTemp)}°</strong><span>{Math.round(value(current,'relative_humidity_2m',nowIndex,70))}% humidity<br/>{Math.round(value(current,'pressure_msl',nowIndex,1008))} hPa</span></div></div>
          <div className="wind-summary"><span className="compass" style={{transform:`rotate(${currentDir}deg)`}}>↑</span><div><strong>{currentWind.toFixed(1)} kt</strong><small>{cardinal(currentDir)} · Gusts {value(current,'wind_gusts_10m',nowIndex,10).toFixed(1)} kt</small></div></div>
        </section>

        <nav className="model-tabs" aria-label="Forecast model">
          {(Object.keys(MODEL_IDS) as ModelKey[]).map(model => <button className={activeModel===model?'active':''} onClick={()=>setActiveModel(model)} key={model}><span>{model}</span><small>{MODEL_META[model].resolution}</small></button>)}
          <button onClick={()=>setActiveView('Compare')}><span>COMPARE</span><small>4 models</small></button>
        </nav>

        <section className="days-strip">
          {days.map((day,i)=>{const label=dayLabel(day);return <button className={selectedDay===i?'active':''} key={day} onClick={()=>setSelectedDay(i)}><b>{label.dow}</b><span>{label.date}</span><em>D+{i}</em></button>})}
        </section>

        <section className={`confidence-bar ${confidence.className}`}>
          <div><b>{confidence.label}</b><span>{confidence.detail}</span></div>
          <small>{sourceDetail}</small>
        </section>

        <ForecastTable data={forecastData} indexes={forecastIndexes} badge={usingExtended?'ENSEMBLE':'HOURLY'} />

        <section className="quick-grid">
          <article onClick={()=>setActiveView('Marine')}><span>WAVES · DAILY MAX</span><strong>{peakWave ? `${peakWave.value.toFixed(1)} m` : '—'}</strong><small>{peakWave ? `${value(marine,'wave_period',peakWave.index,4).toFixed(0)} s · ${cardinal(value(marine,'wave_direction',peakWave.index,290))}` : 'Marine forecast unavailable'}</small></article>
          <article><span>PRECIPITATION · DAILY</span><strong>{rainChance ? `${rainChance.value.toFixed(0)}%` : `${dailyRain.toFixed(1)} mm`}</strong><small>{rainChance ? `${dailyRain.toFixed(1)} mm total expected` : 'Ensemble mean total'}</small></article>
          <article><span>INSTABILITY · DAILY MAX</span><strong>{peakCape ? peakCape.value.toFixed(0) : '—'}</strong><small>{peakCape ? 'CAPE · J/kg' : 'CAPE unavailable at this range'}</small></article>
        </section>
      </>}

      {activeView === 'Compare' && <CompareView forecasts={forecasts} index={nowIndex} indexes={shortIndexes} onSelect={(m)=>{setActiveModel(m);setSelectedDay(0);setActiveView('Forecast')}} />}
      {activeView === 'Marine' && <MarineView data={marine} indexes={shortIndexes} />}
      {activeView === 'Map' && <MapView location={location} />}
      {activeView === 'Saved' && <SavedView favorites={favorites} onSelect={selectLocation} onGps={useGps} />}

      <nav className="bottom-nav" aria-label="Main navigation">
        {(['Forecast','Compare','Marine','Map','Saved'] as ViewKey[]).map(view=><button key={view} className={activeView===view?'selected':''} onClick={()=>setActiveView(view)}><span>{view==='Forecast'?'☼':view==='Compare'?'≋':view==='Marine'?'≈':view==='Map'?'⌖':'☆'}</span>{view}</button>)}
      </nav>

      {searchOpen && <div className="sheet-backdrop" onMouseDown={()=>setSearchOpen(false)}><section className="sheet search-sheet" onMouseDown={e=>e.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2>Choose location</h2><button onClick={()=>setSearchOpen(false)}>×</button></div><div className="search-box"><span>⌕</span><input autoFocus value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search city or spot"/></div><button className="gps-row" onClick={useGps}><span>◎</span><div><b>Use current location</b><small>Get forecast from your GPS position</small></div></button>{results.map(r=><button className="result-row" key={`${r.latitude}${r.longitude}`} onClick={()=>selectLocation(r)}><span>⌖</span><div><b>{r.name}</b><small>{r.country}</small></div></button>)}</section></div>}

      {settingsOpen && <div className="sheet-backdrop" onMouseDown={()=>setSettingsOpen(false)}><section className="sheet settings-sheet" onMouseDown={e=>e.stopPropagation()}><div className="sheet-handle"/><div className="sheet-title"><h2>Preferences</h2><button onClick={()=>setSettingsOpen(false)}>×</button></div><label className="setting-row"><span><b>Wind alert</b><small>Notify above your preferred speed</small></span><strong>{windAlert} kt</strong></label><input className="range" type="range" min="5" max="40" value={windAlert} onChange={e=>setWindAlert(Number(e.target.value))}/><button className="primary-action" onClick={enableAlerts}>Enable browser alerts</button><div className="about-box"><b>Data sources</b><p>ECMWF, NOAA GFS, DWD ICON and ECMWF AIFS via Open-Meteo. Marine forecasts combine public wave and ocean models.</p></div></section></div>}
    </main>
  );
}

function ForecastTable({data,indexes,badge='HOURLY'}:{data:Forecast|null;indexes:number[];badge?:string}) {
  const rows = [
    {label:'Direction',unit:'',render:(i:number)=><span className="table-arrow" style={{transform:`rotate(${value(data,'wind_direction_10m',i)}deg)`}}>↑</span>},
    {label:'Wind',unit:'kt',render:(i:number)=>value(data,'wind_speed_10m',i).toFixed(1)},
    {label:'Gusts',unit:'kt',render:(i:number)=>value(data,'wind_gusts_10m',i).toFixed(1)},
    {label:'Temperature',unit:'°C',render:(i:number)=><span className="temp-pill">{Math.round(value(data,'temperature_2m',i))}°</span>},
    {label:'Pressure',unit:'hPa',render:(i:number)=>Math.round(value(data,'pressure_msl',i))},
    {label:'Rain',unit:'mm',render:(i:number)=>value(data,'precipitation',i).toFixed(1)},
    {label:'Clouds',unit:'%',render:(i:number)=>Math.round(value(data,'cloud_cover',i))},
  ];
  return <section className="forecast-card"><div className="section-title"><div><p className="eyebrow">DETAILED FORECAST</p><h2>Wind & weather</h2></div><span className="live-badge">{badge}</span></div><div className="weather-table"><div className="table-head table-label"><b>LOCAL TIME</b></div>{indexes.map(i=><div className="table-head" key={i}>{formatHour(data?.hourly?.time?.[i]||'')}</div>)}{rows.map(row=><div className="table-row" key={row.label}><div className="table-label"><b>{row.label}</b><small>{row.unit}</small></div>{indexes.map(i=><div className="table-cell" key={i}>{row.render(i)}</div>)}</div>)}</div></section>;
}

function CompareView({forecasts,index,indexes,onSelect}:{forecasts:Partial<Record<ModelKey,Forecast>>;index:number;indexes:number[];onSelect:(m:ModelKey)=>void}) {
  return <section className="view-page"><div className="view-heading"><p className="eyebrow">MODEL AGREEMENT</p><h1>Compare forecasts</h1><p>See where the leading forecast systems agree—and where they do not.</p></div><div className="compare-grid">{(Object.keys(MODEL_IDS) as ModelKey[]).map(model=>{const d=forecasts[model]||null;return <button key={model} onClick={()=>onSelect(model)}><div className="model-card-head"><span>{model}</span><small>{MODEL_META[model].provider}</small></div><strong>{value(d,'wind_speed_10m',index).toFixed(1)} <i>kt</i></strong><p>{Math.round(value(d,'temperature_2m',index))}° · Gusts {value(d,'wind_gusts_10m',index).toFixed(0)} kt</p><div className="mini-bars">{indexes.slice(0,6).map(i=><span key={i} style={{height:`${Math.min(44,8+value(d,'wind_speed_10m',i)*2)}px`}}/>)}</div></button>})}</div><section className="agreement-card"><div className="section-title"><div><p className="eyebrow">NEXT 24 HOURS</p><h2>Wind spread</h2></div><span className="agreement-score">GOOD AGREEMENT</span></div>{indexes.slice(0,6).map(i=>{const vals=(Object.keys(MODEL_IDS) as ModelKey[]).map(m=>value(forecasts[m]||null,'wind_speed_10m',i)).filter(Boolean);const min=Math.min(...vals),max=Math.max(...vals);return <div className="spread-row" key={i}><time>{formatHour(forecasts.ECMWF?.hourly.time[i]||'')}</time><div><span style={{left:`${Math.min(75,min*3)}%`,width:`${Math.max(4,(max-min)*3)}%`}}/></div><b>{min.toFixed(0)}–{max.toFixed(0)} kt</b></div>})}</section></section>;
}

function MarineView({data,indexes}:{data:Forecast|null;indexes:number[]}) {
  const idx=indexes[0]||0; return <section className="view-page"><div className="view-heading"><p className="eyebrow">MARINE FORECAST</p><h1>Sea conditions</h1><p>Wave, swell and current guidance for your selected coordinates.</p></div><div className="marine-hero"><div className="wave-orb"><span>≈</span></div><div><p>Significant wave height</p><strong>{value(data,'wave_height',idx,.4).toFixed(1)} m</strong><small>{cardinal(value(data,'wave_direction',idx,290))} · {value(data,'wave_period',idx,4).toFixed(0)} second period</small></div></div><div className="marine-grid"><article><span>PRIMARY SWELL</span><strong>{value(data,'swell_wave_height',idx,.3).toFixed(1)} m</strong><small>{cardinal(value(data,'swell_wave_direction',idx,290))} · {value(data,'swell_wave_period',idx,4).toFixed(0)} s</small></article><article><span>CURRENT</span><strong>{value(data,'ocean_current_velocity',idx,0).toFixed(2)} km/h</strong><small>{cardinal(value(data,'ocean_current_direction',idx,270))}</small></article><article><span>SEA LEVEL</span><strong>{value(data,'sea_level_height_msl',idx,0).toFixed(2)} m</strong><small>Modelled height</small></article></div><section className="marine-timeline"><div className="section-title"><div><p className="eyebrow">SEA STATE</p><h2>Next 24 hours</h2></div></div>{indexes.map(i=><div className="marine-row" key={i}><time>{formatHour(data?.hourly.time[i]||'')}</time><span className="wave-direction" style={{transform:`rotate(${value(data,'wave_direction',i)}deg)`}}>↑</span><b>{value(data,'wave_height',i,.4).toFixed(1)} m</b><small>{value(data,'wave_period',i,4).toFixed(0)} s</small><div className="wave-meter"><span style={{width:`${Math.min(100,value(data,'wave_height',i,.4)*45)}%`}}/></div></div>)}</section><p className="data-note">Sea-level values are model guidance and should not replace official local tide tables.</p></section>;
}

function MapView({location}:{location:Location}) {
  const d=.35; const bbox=`${location.longitude-d},${location.latitude-d},${location.longitude+d},${location.latitude+d}`;
  return <section className="view-page map-page"><div className="view-heading"><p className="eyebrow">FORECAST MAP</p><h1>Explore the area</h1><p>Tap or search a location to load its forecast.</p></div><div className="layer-chips"><button className="active">Location</button><button>Wind</button><button>Waves</button><button>Rain</button></div><div className="map-frame"><iframe title={`Map of ${location.name}`} src={`https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${location.latitude},${location.longitude}`}/><div className="map-pin"><span>⌖</span><b>{location.name}</b></div></div><p className="data-note">Weather overlays will be added after the point-forecast engine is verified on your phone.</p></section>;
}

function SavedView({favorites,onSelect,onGps}:{favorites:Location[];onSelect:(l:Location)=>void;onGps:()=>void}) {
  return <section className="view-page"><div className="view-heading"><p className="eyebrow">QUICK ACCESS</p><h1>Saved spots</h1><p>Your favorite forecasts stay on this device.</p></div><button className="saved-location gps" onClick={onGps}><span>◎</span><div><b>Current location</b><small>Use GPS coordinates</small></div><i>›</i></button>{favorites.map((f,i)=><button className="saved-location" onClick={()=>onSelect(f)} key={`${f.name}${i}`}><span>☆</span><div><b>{f.name}</b><small>{f.country} · {f.latitude.toFixed(2)}, {f.longitude.toFixed(2)}</small></div><i>›</i></button>)}</section>;
}
