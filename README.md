# WeatherDeck

WeatherDeck is a personal, English-language Android weather dashboard inspired by professional wind and marine forecast tools. It combines several freely available forecast models without requiring a subscription or API key.

## Features

- ECMWF IFS, NOAA GFS, DWD ICON and ECMWF AIFS model selection
- Side-by-side model comparison with a measured agreement score
- 21-day rolling forecast
- NOAA GEFS 31-member ensemble mean for the extended range
- Forecast-confidence labels and ensemble spread for temperature and wind
- Wind, gusts, temperature, pressure, precipitation, cloud cover and CAPE
- Marine wave, swell and current guidance
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
