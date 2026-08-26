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
- Keep location permission on demand: request it only after the user asks for GPS.
- Only grant WebView geolocation to the private app origin.
- Do not add Android notification permission unless native background notifications are actually implemented. Current Android wind alerts are in-app banners.
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
