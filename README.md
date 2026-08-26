# WeatherDeck

WeatherDeck is a personal, English-language Android weather dashboard inspired by professional wind and marine forecast tools. It combines several freely available forecast models without requiring a subscription or API key.

## Features

- One table per day: pick a day and a model, and every three-hourly reading for
  that day — air and sea together — is on a single screen
- ECMWF IFS, NOAA GFS, DWD ICON and ECMWF AIFS model selection, plus a MEAN
  option that averages them with the hourly spread and contributing model count
- Wind and waves graphed for the selected day at full hourly resolution: wind as
  bars coloured by strength with direction arrows above them, waves as their own
  strip below
- A quiet offshore-wind warning, worked out for any coastline in the world
- Model comparison in place: one wind row per model, toggled on the same table
- Wind carries a colour scale, hours after dark are shaded, and each day chip
  shows that day's temperature range and strongest wind
- 21-day rolling forecast
- NOAA GEFS 31-member ensemble mean for the extended range
- Forecast-confidence labels and ensemble spread for temperature and wind
- Wind, gusts, temperature, pressure, precipitation, cloud cover and CAPE
- Wave, swell, wind wave, water temperature, current and sea level as rows of
  that same table
- Location search, GPS location and on-device saved spots
- Wind-alert threshold with an in-app banner
- Offline cache of the last successful forecast, clearly labelled as such
- Automatic refresh every 30 minutes, on regaining connectivity, and on focus (throttled)

## Home-screen widget

A 2x2 Android widget shows today's temperature, wind and wave ranges over a
scene coloured by how much wind the day holds.

It is deliberately static. A widget that animates has to be redrawn to move, and
paying battery for motion nobody is watching is a bad trade — the colour does the
work instead. The palette follows the same wind bands as the forecast table, so
the widget answers "can I go out today" before any number is read.

The scene is drawn on a `Canvas` at the widget's real pixel size, read from
`getAppWidgetOptions()` and multiplied by the display density, in `ARGB_8888`.
`RGB_565` would halve the memory, but a smooth radial gradient in five and six
bits per channel bands visibly. The readings sit above the scene as real
`TextView`s, so they stay sharp and cost nothing to redraw.

The widget cannot read the interface's data — that lives in the WebView's
localStorage, which native code has no access to — so it fetches its own small
slice of Open-Meteo on a background thread held open by `goAsync()`, with no
scheduling library. The system refreshes it three-hourly without waking the
device, and the app pushes one every time it is closed if what the widget holds
has gone stale. The app mirrors the chosen location into `SharedPreferences` with
a plain `evaluateJavascript` read; no JavaScript interface is installed, so the
embedded map frame has nothing to reach for.

Every reading defaults to a dash in the layout itself and every failure path is
caught and logged, so the widget can never render as blank space with nothing to
say about why.

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

Wind is the one variable with a colour scale, green through amber to red. It is
a severity scale rather than a plain magnitude one: on a board or at a helm, 8 kt
and 28 kt are not two amounts of the same thing, they are two different days.
Every band's ink was checked against its own fill rather than picked by eye —
worst case 4.86:1, which matters on a phone in direct sun. Every cell still
prints its number, so colour is never the only channel, and one scale doing one
job beats colouring every row.

### The graph

Wind is drawn as bars rather than a curve. A bar carries its own colour, and
colour is how strength is read everywhere else in this app; a thin line at this
size carries neither well. Above the bars sits the reading the table buries and
the sea decides everything by — direction — with offshore hours marked, so
whether a session is on can be answered without reading a number.

The sea is drawn as a sea rather than as a chart of its height. An area plot of
wave height is flat by nature — height barely moves across a day — so it reads as
a sloping line that means nothing, and height alone is not what anyone reads: a
metre of long groundswell and a metre of short chop are different water. So the
surface itself is drawn, amplitude from the height and wavelength from the
period. Long swell comes out as slow rollers, wind chop as tight ripples.

It sits in its own strip rather than as a second line in the wind box, because
knots and metres are different scales and sharing an axis makes both unreadable.
The sea is blue for a reason: the wind ramp already owns green through red, and
the orange first used for waves sat 1.7 deltaE from the 25-30 kt band — close
enough that on a windy day the sea strip and the wind bars read as the same
thing.

### Reading the table at a glance

Every row used to carry the same visual weight, so there was nowhere for the eye
to land. Three things fix that without hiding a single number:

- **Tiers.** The readings a session turns on — direction, wind, gusts, waves,
  period — are set loud; supporting readings normal; reference readings recede.
- **A sparkline beside every row label**, scaled to that row's own range. Working
  out whether something is rising or falling by reading eight numbers is the slow
  part of a table; the shape answers it before the numbers are read at all.
- **The current hour is marked**, so "where am I" needs no arithmetic against the
  clock.

### Offshore wind

Wind blowing from the shore out to sea is the case that carries a paddler out
faster than they can come back, and it needs no configuration to detect. On a new
spot the app asks Open-Meteo's elevation endpoint about a ring of points around
it — sixteen bearings at five and twelve kilometres — and reads sea as zero. The
answer is kept as a sixteen-sector water mask rather than one average bearing,
because on a bay the water wraps around and an average flattens exactly the
detail that matters. The marine endpoint is no good for this: it snaps to a
coarse grid and answers for inland points near the coast.

A warning appears only when the wind arrives over land and leaves over water, and
only when a neighbouring sector agrees, so a wind sitting on a sector boundary
cannot flip it on and off between runs. It is a dot under the direction arrow and
one line under the table; on an ordinary day nothing changes.

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
