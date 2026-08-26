# WeatherDeck

WeatherDeck is a personal, English-language Android weather dashboard inspired by professional wind and marine forecast tools. It combines several freely available forecast models without requiring a subscription or API key.

## Features

- One table per day: pick a day and a model, and every three-hourly reading for
  that day — air and sea together — is on a single screen
- ECMWF IFS, NOAA GFS, DWD ICON and ECMWF AIFS model selection, plus a MEAN
  option that averages them with the hourly spread and contributing model count
- A wind graph for the selected day at full hourly resolution, with the gust
  envelope and your alert threshold marked
- Model comparison in place: one wind row per model, toggled on the same table
- Wind carries a colour scale, hours after dark are shaded, and each day chip
  shows that day's temperature range and strongest wind
- 21-day rolling forecast
- NOAA GEFS 31-member ensemble mean for the extended range
- Forecast-confidence labels and ensemble spread for temperature and wind
- Wind, gusts, temperature, pressure, precipitation, cloud cover and CAPE
- Wave, swell, wind wave, current and sea level as rows of that same table
- Location search, GPS location and on-device saved spots
- Wind-alert threshold with an in-app banner
- Offline cache of the last successful forecast, clearly labelled as such
- Automatic refresh every 30 minutes, on regaining connectivity, and on focus (throttled)

## Forecast strategy

WeatherDeck uses the selected operational model wherever that model actually
publishes values. Open-Meteo returns a full 16-day time axis for every model and
fills the hours a model does not cover with `null`, so availability is decided on
the values rather than on the timestamps. ICON, for example, runs out after
roughly 7.5 days even though its time axis spans 16.

For dates the operational model does not cover, the app switches to the NOAA GEFS
0.5-degree ensemble mean and labels the source accordingly. As a date moves into
operational range, the higher-resolution forecast takes over again.

### Reading it at a glance

Wind is the one variable with a colour scale — a single blue ramp, dark-anchored
so calm air recedes into the panel and a gale reads brightest. Lightness is
monotone across the ramp, adjacent steps differ by dL >= 0.09, and each band's
ink clears 4.5:1 against its own fill. Every cell still prints its number, so
colour is never the only channel. One scale doing one job beats colouring every
row.

Columns after dark are shaded and marked, so a run of night hours reads as a
night instead of being worked out from the clock. Day chips carry that day's
temperature range and strongest wind, which is usually enough to decide whether
a day is worth opening at all.

### One table

Everything for the selected day lives in a single three-hourly table, grouped
into AIR, MODEL AGREEMENT (for the mean) and SEA. The wave models run on their
own ten-day axis, so their series are remapped onto the weather axis by
timestamp rather than by array position, and the sea rows simply drop out past
their range. Rows are kept or dropped based on the hours actually on screen, so
a variable a model stops publishing part-way through the range disappears for
that day instead of rendering a line of dashes.

Sea conditions do not depend on the selected weather model — the wave model is
the same whichever one is chosen — and the table says so.

### The model mean

The MEAN tab averages the operational models hour by hour. Only the models that
publish a value at a given hour contribute, so the mean narrows on its own as
the shorter-range models drop out — the table shows how many models went into
each column and how far apart they were, because a mean of one model is not a
consensus. Wind direction is averaged as a unit vector: the arithmetic mean of
350° and 10° is 180°, which points the opposite way.

Models also differ in *which* variables they publish — ECMWF AIFS provides no
gusts, no CAPE and no precipitation probability. Rows and cards for variables a
model does not publish are hidden or shown as "—". **Missing readings are never
replaced with a plausible-looking default.**

Extended forecasts are inherently uncertain. WeatherDeck labels confidence by
lead time and shows ensemble spread where available. The app is not a substitute
for official weather warnings, marine bulletins or local tide tables.

## Data sources

Forecast and geocoding data are retrieved from [Open-Meteo](https://open-meteo.com/) using its public non-commercial endpoints. Map data comes from [OpenStreetMap](https://www.openstreetmap.org/).

## Architecture

The interface is a single Vite + React SPA (`app/`, `src/`). `npm run build`
emits a static site to `dist/`.

The Android wrapper is a thin `WebView` that packages `dist/` as app assets and
serves them over the private origin `https://appassets.androidplatform.net`
through `shouldInterceptRequest`. The page therefore runs with a real origin:
root-relative URLs, `localStorage` and the service worker all behave exactly as
they do on the web. Network access is used only for live forecast, geocoding and
map data.

Notifications: Android's `WebView` exposes no Web Notifications API, so wind
alerts are delivered as an in-app banner. In a browser or installed PWA, a system
notification is sent as well if the user grants permission.

## Development

Requirements:

- Node.js 22 or newer
- JDK 17
- Android SDK 36 for APK builds

```bash
npm install
npm run dev        # dev server
npm run check      # lint + typecheck + build
```

Build the Android debug APK after `npm run build`, with `JAVA_HOME` and `ANDROID_HOME` set:

```bash
cd android && ./gradlew assembleDebug
```

The Gradle build fails early with a clear message if `dist/` has not been built.

Release builds are signed only when the keystore is supplied through the
environment; otherwise `assembleRelease` produces an unsigned APK:

```bash
export WEATHERDECK_KEYSTORE=/path/to/weatherdeck.jks
export WEATHERDECK_KEYSTORE_PASSWORD=...
export WEATHERDECK_KEY_ALIAS=...
export WEATHERDECK_KEY_PASSWORD=...
```

## License

This project is released under the MIT License. Forecast data and map tiles remain subject to their respective providers' licenses and attribution requirements.
