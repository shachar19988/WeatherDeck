# WeatherDeck agent guide

## Project goal

WeatherDeck is a personal, English-language Android weather dashboard. Keep it subscription-free and suitable for non-commercial personal use. The React interface must also remain usable as a normal web app.

## Architecture

- `app/weather-app.tsx`: forecast fetching, state and UI.
- `app/globals.css`: all interface styling.
- `src/main.tsx`: React entry point.
- `public/sw.js`: offline shell only; never cache forecast API responses.
- `android/`: native Android WebView wrapper.
- `android/app/src/main/java/com/weatherdeck/personal/WidgetData.java`: widget forecast fetch and native cache.
- `android/app/src/main/java/com/weatherdeck/personal/WidgetProvider.java`: widget lifecycle and refresh handling.
- `android/app/src/main/java/com/weatherdeck/personal/WidgetRenderer.java`: adaptive weather-scene bitmap rendering.
- Vite writes the web build to `dist/`; Gradle packages that directory as Android assets.
- Android serves packaged assets through `https://appassets.androidplatform.net` in `MainActivity.java`.

## Data rules

- Never invent or substitute plausible weather values when a source returns `null`, omits a variable or fails. Display `—` or a clear unavailable message.
- Open-Meteo may pad a model's time axis with `null` values beyond its real horizon. Determine coverage from actual finite values, not timestamp presence.
- Use the selected operational model while it publishes data; use the NOAA GEFS ensemble mean for the extended 21-day range.
- The `MEAN` option combines available operational models by timestamp. Average compass directions as unit vectors, never as ordinary numbers, and show both model count and spread where meaningful.
- Align weather, marine, daylight and per-model comparison series by timestamp. Their array positions are not guaranteed to describe the same hour.
- Not every model publishes every variable. Keep missing-variable handling explicit.
- `timezone=auto` returns timestamps in the forecast location's local clock. Use `utc_offset_seconds` when comparing them with the current time.
- Marine coverage is shorter and may be completely absent for inland points. Do not fabricate sea conditions.
- The main forecast table is the single reading surface. Keep air, model-agreement and sea rows grouped there; do not recreate separate Compare or Marine screens unless a new workflow genuinely requires them.
- The wind graph uses full-hourly data for the selected day. Its table remains the accessible numeric equivalent, and colour must never be the only information channel.
- Forecast API responses are live data. The service worker must not cache cross-origin API responses; the app's labelled localStorage cache handles offline fallback.

## Android rules

- Run `npm run build` before Gradle so `dist/index.html` and hashed assets exist.
- Preferences shows the build's commit and time, injected by Vite. Keep it: without it a screenshot of a bug does not say which build it came from, and "it still happens" is indistinguishable from "still the old APK".
- System bar insets are applied natively, by padding the root view in `MainActivity.keepClearOfSystemBars`, from three sources — the inset listener, `getRootWindowInsets()`, and the platform's `status_bar_height` as a floor — taking the largest and never shrinking within a session. One source is not enough: depending on the theme the decor view can consume the insets before the listener sees them, and it then fires with zeros. Do not move this to CSS `env(safe-area-inset-*)`: that relies on the WebView reporting insets into the page, which varies by Android and WebView version, and this app runs from API 26. From targetSdk 35 the window is laid out edge to edge and `statusBarColor` is ignored, so without the padding the header draws under the clock.
- Keep location permission on demand: request it only after the user asks for GPS.
- Only grant WebView geolocation to the private app origin.
- The notification permission is held for one purpose: PlanWatch, which posts only when a planned session changes materially. Ask for it when a session is saved, never at launch, and do not widen it to anything else.
- A saved session's `limits` are re-stamped from `PROFILES` on load and written back to storage, not just refreshed in memory. Android reads storage, so re-stamping only the copy on screen leaves the notifications running on superseded rules — the half that matters when the app is shut.
- Sessions live in `weatherdeck:events` as a list, each carrying its own `limits` and `label` so Android needs no rules of its own. Baselines are keyed per session id and cleared when a session is deleted or edited — a stale baseline reports a change that never happened.
- A session may name an hour. When it does, the verdict is about that hour alone, on both sides. Seven good hours are no comfort if none of them is the one you are on the water.
- Android writes `weatherdeck:notify` into localStorage so the planner can say whether alerts actually work. That direction only — Java writes, the page reads. Do not install a JavaScript interface to make it two-way.
- The wave row draws its own sea: the surface is carried through cell edges via `Neighbours`, so a row is one continuous surface, not a line of tiles. Colour carries severity, shape carries size. `WAVE_DRAWN_MAX` is 1.5 m, set from measurement rather than from the colour ramp's 2 m top — re-measure before changing it.
- There is no chart above the table. One was tried and removed: a graph of a single chosen day was a smaller, worse copy of the row below it and cost a screenful. Put expression into the table rows instead.
- Waves come from `WAVE_MODELS`, not from the six weather models. Do not add `best_match` — measured at Haifa, Biarritz and Bali it is byte-identical to `meteofrance_wave` and would weight it twice. Do not add `ncep_gfswave025`: at Biarritz it sits 1.2 m from every other model while `ncep_gfswave016` agrees with them, which is a bad grid point, not a real disagreement. Regional models are absent outside their domain by design; the per-hour count carries that.
- Surfing is judged on `swell_wave_height` and `swell_wave_period` with `windWaveMax` holding the chop down, never on total wave height. Flat-water and boat profiles use the total, which is the right question for them.
- Disagreement thresholds (`SPLIT_WAVE_M`, `SPLIT_WIND_KT`) are set above the measured 90th percentile so a split reads as unusual. Re-measure before changing them; a warning that always fires is wallpaper.
- Thresholds are user-editable: `PROFILE_DEFAULTS` holds the defaults, `weatherdeck:limits` holds the user's numbers, and `profilesWith()` merges them. Evaluate with the merged set, never with `PROFILE_DEFAULTS` directly. Only fields already present in an activity's defaults are offered for editing — a field to type into is an invitation to invent a rule that was never intended.
- Editing a threshold re-stamps existing sessions and writes them back, for the same reason the load path does.
- Day chips show wind as a range, never the peak alone. A peak reads as "the wind that day", so a morning of 4 kt looked like 9 and a correct rejection looked like a broken rule.
- A session pinned to an hour reports that hour's readings and that hour's failing rule — never the day's mean. Two winds in one line read as a contradiction.
- `bindingReason()` names the constraint that fails most often across a day, not the first. An hour can fail several at once, and the one you keep hitting is the one worth knowing.
- The breeze note asks the coastline mask directly rather than reading `OFFSHORE_KEY`. That series encodes offshore as 1 and everything else as null, so onshore and unknown are indistinguishable — which is exactly the sea-breeze case.
- The widget's subject is today. A planned session is a note underneath it, built from the count the background check already made; it fetches nothing of its own.
- Activity thresholds live in one place, `PROFILES[].limits`, as plain numbers. The Android side reads those numbers out of the marked plan; it must never grow its own copy of the rules. What it cannot apply (offshore wind, which needs the coastline probe) it simply omits, and it starts its comparison from its own first count so the gap never reads as a change.
- Preserve the startup diagnostic view and interface polling in `MainActivity`.
- The home-screen widget fetches its own small Open-Meteo payload because native code cannot read WebView forecast state. Keep its cached readings clearly labelled when stale and preserve dashes for missing values.
- Mirror the selected WebView location to native `SharedPreferences` without exposing a JavaScript interface to embedded third-party frames.
- Keep widget bitmaps within `RemoteViews` transaction limits and use only supported `RemoteViews` child types.

## Verification

Before committing changes, run:

```bash
npm ci
npm run check
```

Then build Android with JDK 17 and Android SDK 36:

```bash
cd android
./gradlew assembleDebug
```

GitHub Actions repeats lint, TypeScript checking, the Vite build and a debug APK build for pull requests and `main`.

## Release version

Keep these versions aligned when releasing:

- `package.json`
- `package-lock.json`
- `android/app/build.gradle` (`versionCode` and `versionName`)

APK files, signing keys, `android/local.properties`, generated builds and local hosting metadata must not be committed.
