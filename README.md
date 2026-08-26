# WeatherDeck

WeatherDeck is a personal, English-language Android weather dashboard inspired by professional wind and marine forecast tools. It combines several freely available forecast models without requiring a subscription or API key.

## Features

- ECMWF IFS, NOAA GFS, DWD ICON and ECMWF AIFS model selection
- Side-by-side model comparison
- 21-day rolling forecast
- NOAA GEFS 31-member ensemble mean for the extended range
- Forecast-confidence labels and ensemble spread for temperature and wind
- Wind, gusts, temperature, pressure, precipitation, cloud cover and CAPE
- Marine wave, swell and current guidance
- Location search, GPS location and on-device saved spots
- Offline cache of the last successful forecast
- Automatic refresh every 30 minutes and whenever the app regains focus

## Forecast strategy

WeatherDeck uses the selected operational model while it is available. For dates beyond that model's horizon, it automatically switches to the NOAA GEFS 0.5-degree ensemble mean. As a date gets closer and enters the operational model range, the app automatically starts using the higher-resolution forecast.

Extended forecasts are inherently uncertain. WeatherDeck labels confidence by lead time and shows ensemble spread where available. The app is not a substitute for official weather warnings, marine bulletins or local tide tables.

## Data sources

Forecast and geocoding data are retrieved from [Open-Meteo](https://open-meteo.com/) using its public non-commercial endpoints. Map data comes from [OpenStreetMap](https://www.openstreetmap.org/).

## Development

Requirements:

- Node.js 22 or newer
- JDK 17
- Android SDK 36 for APK builds

Install and build the web interface:

```bash
npm install
npm run build
```

Build the Android debug APK after setting `JAVA_HOME` and `ANDROID_HOME`:

```bash
cd android
./gradlew assembleDebug
```

The Android wrapper loads the fully inlined Vite build from local app assets. Internet access is used only for live forecast, geocoding and map data.

## License

This project is released under the MIT License. Forecast data and map tiles remain subject to their respective providers' licenses and attribution requirements.
