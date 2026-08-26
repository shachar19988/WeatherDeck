package com.weatherdeck.personal;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The widget cannot read the interface's data: that lives in the WebView's own
 * localStorage, which native code has no access to. It therefore fetches its own
 * small slice of Open-Meteo and keeps it in SharedPreferences, which is also
 * where the app writes the location the user last chose.
 *
 * Every field is optional. A range that could not be read stays absent and the
 * widget renders a dash rather than a number, matching the rest of the app.
 */
final class WidgetData {
    static final String PREFS = "weatherdeck.widget";
    static final String KEY_LAT = "lat";
    static final String KEY_LON = "lon";
    static final String KEY_PLACE = "place";

    private static final String KEY_TEMP_LOW = "tempLow";
    private static final String KEY_TEMP_HIGH = "tempHigh";
    private static final String KEY_WIND_LOW = "windLow";
    private static final String KEY_WIND_HIGH = "windHigh";
    private static final String KEY_WAVE_LOW = "waveLow";
    private static final String KEY_WAVE_HIGH = "waveHigh";
    private static final String KEY_CODE = "weatherCode";
    private static final String KEY_IS_DAY = "isDay";
    private static final String KEY_UPDATED = "updatedAt";

    private static final double MISSING = Double.NaN;
    private static final int TIMEOUT_MS = 12000;

    final String place;
    final double tempLow, tempHigh;
    final double windLow, windHigh;
    final double waveLow, waveHigh;
    final int weatherCode;
    final boolean isDay;
    final long updatedAt;

    private WidgetData(SharedPreferences prefs) {
        place = prefs.getString(KEY_PLACE, "Haifa");
        tempLow = readDouble(prefs, KEY_TEMP_LOW);
        tempHigh = readDouble(prefs, KEY_TEMP_HIGH);
        windLow = readDouble(prefs, KEY_WIND_LOW);
        windHigh = readDouble(prefs, KEY_WIND_HIGH);
        waveLow = readDouble(prefs, KEY_WAVE_LOW);
        waveHigh = readDouble(prefs, KEY_WAVE_HIGH);
        weatherCode = prefs.getInt(KEY_CODE, -1);
        isDay = prefs.getBoolean(KEY_IS_DAY, true);
        updatedAt = prefs.getLong(KEY_UPDATED, 0L);
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static WidgetData load(Context context) {
        return new WidgetData(prefs(context));
    }

    static boolean olderThan(Context context, long ageMs) {
        long updated = prefs(context).getLong(KEY_UPDATED, 0L);
        return updated <= 0L || System.currentTimeMillis() - updated > ageMs;
    }

    static boolean has(double value) {
        return !Double.isNaN(value);
    }

    private static double readDouble(SharedPreferences prefs, String key) {
        String raw = prefs.getString(key, null);
        if (raw == null) return MISSING;
        try {
            return Double.parseDouble(raw);
        } catch (NumberFormatException invalid) {
            return MISSING;
        }
    }

    private static void writeDouble(SharedPreferences.Editor editor, String key, double value) {
        if (Double.isNaN(value)) editor.remove(key);
        else editor.putString(key, Double.toString(value));
    }

    /** Blocking. Called only from a background thread. */
    static void refresh(Context context) {
        SharedPreferences prefs = prefs(context);
        double latitude = readDouble(prefs, KEY_LAT);
        double longitude = readDouble(prefs, KEY_LON);
        if (!has(latitude) || !has(longitude)) {
            latitude = 32.794;
            longitude = 34.9896;
        }

        SharedPreferences.Editor editor = prefs.edit();
        try {
            JSONObject forecast = fetch("https://api.open-meteo.com/v1/forecast"
                    + "?latitude=" + latitude + "&longitude=" + longitude
                    + "&hourly=temperature_2m,wind_speed_10m"
                    + "&current=weather_code,is_day"
                    + "&forecast_days=1&timezone=auto&wind_speed_unit=kn");
            JSONObject hourly = forecast.optJSONObject("hourly");
            double[] temperature = range(hourly, "temperature_2m");
            double[] wind = range(hourly, "wind_speed_10m");
            writeDouble(editor, KEY_TEMP_LOW, temperature[0]);
            writeDouble(editor, KEY_TEMP_HIGH, temperature[1]);
            writeDouble(editor, KEY_WIND_LOW, wind[0]);
            writeDouble(editor, KEY_WIND_HIGH, wind[1]);

            JSONObject current = forecast.optJSONObject("current");
            if (current != null) {
                editor.putInt(KEY_CODE, current.optInt("weather_code", -1));
                editor.putBoolean(KEY_IS_DAY, current.optInt("is_day", 1) == 1);
            }
            editor.putLong(KEY_UPDATED, System.currentTimeMillis());
        } catch (IOException | JSONException failure) {
            // Keep whatever was cached; a stale reading is labelled, not replaced.
        }

        try {
            JSONObject marine = fetch("https://marine-api.open-meteo.com/v1/marine"
                    + "?latitude=" + latitude + "&longitude=" + longitude
                    + "&hourly=wave_height&forecast_days=1&timezone=auto");
            double[] wave = range(marine.optJSONObject("hourly"), "wave_height");
            writeDouble(editor, KEY_WAVE_LOW, wave[0]);
            writeDouble(editor, KEY_WAVE_HIGH, wave[1]);
        } catch (IOException | JSONException failure) {
            // Inland points legitimately have no waves; leave the range absent.
            editor.remove(KEY_WAVE_LOW).remove(KEY_WAVE_HIGH);
        }
        editor.apply();
    }

    /** Open-Meteo pads series with nulls, so only finite entries count. */
    private static double[] range(JSONObject hourly, String key) {
        if (hourly == null) return new double[]{MISSING, MISSING};
        JSONArray series = hourly.optJSONArray(key);
        if (series == null) return new double[]{MISSING, MISSING};
        double low = Double.POSITIVE_INFINITY;
        double high = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < series.length(); i++) {
            if (series.isNull(i)) continue;
            double value = series.optDouble(i, Double.NaN);
            if (Double.isNaN(value)) continue;
            low = Math.min(low, value);
            high = Math.max(high, value);
        }
        if (low > high) return new double[]{MISSING, MISSING};
        return new double[]{low, high};
    }

    private static JSONObject fetch(String url) throws IOException, JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (connection.getResponseCode() / 100 != 2) {
                throw new IOException("HTTP " + connection.getResponseCode());
            }
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            return new JSONObject(body.toString());
        } finally {
            connection.disconnect();
        }
    }
}
