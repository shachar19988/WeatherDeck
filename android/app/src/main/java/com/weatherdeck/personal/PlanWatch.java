package com.weatherdeck.personal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import java.io.IOException;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Watches a day the user has marked for an activity and says something when the
 * forecast for it turns.
 *
 * The rules are not reimplemented here. The interface writes its thresholds out
 * as plain numbers when the day is marked, and this only applies them, so there
 * is one definition of what "suits sailing" means and Java is not a second
 * opinion. What it cannot apply is offshore wind, which needs the coastline
 * probe the interface holds — so the count here can be a little generous, and
 * the notification says to open the app rather than pretending to be the last
 * word.
 *
 * It runs on the widget's existing three-hourly refresh. No scheduler, no extra
 * wakeups, and nothing at all unless a day is actually marked.
 */
final class PlanWatch {
    private static final String TAG = "WeatherDeckPlan";
    private static final String CHANNEL = "weatherdeck.plan";
    private static final int NOTIFICATION_ID = 4201;
    /**
     * Below this the count is just forecast jitter and not worth a buzz. Losing
     * the last suitable hour is exempt: one hour to none is the whole point.
     */
    private static final int MEANINGFUL_CHANGE = 2;

    /** Twice a day. Inexact, so Android is free to batch it with other wake-ups. */
    private static final long INTERVAL_MS = android.app.AlarmManager.INTERVAL_HALF_DAY;

    /** Kept in step with WAVE_MODELS in the interface; see the note there. */
    private static final String WAVE_MODELS = "ecmwf_wam025,gwam,ewam,ncep_gfswave016,meteofrance_wave";

    static final String KEY_PLAN = "events";
    /** Per session, so one trip going quiet cannot mask another one turning. */
    private static final String LAST_HOURS_PREFIX = "lastHours:";
    static final String KEY_NOTIFY_STATE = "notifyState";

    private PlanWatch() {
    }

    /** Blocking. Called only from the widget's background thread. */
    static void check(Context context) {
        SharedPreferences prefs = WidgetData.prefs(context);
        String raw = prefs.getString(KEY_PLAN, null);
        if (raw == null || raw.isEmpty()) return;

        try {
            JSONArray sessions = new JSONArray(raw);
            double latitude = readDouble(prefs, WidgetData.KEY_LAT, 32.794);
            double longitude = readDouble(prefs, WidgetData.KEY_LON, 34.9896);
            String today = today();
            for (int i = 0; i < sessions.length(); i++) {
                JSONObject session = sessions.optJSONObject(i);
                if (session != null) checkOne(context, prefs, session, latitude, longitude, today);
            }
        } catch (JSONException malformed) {
            Log.w(TAG, "Session list unreadable", malformed);
        }
    }

    private static void checkOne(Context context, SharedPreferences prefs, JSONObject session,
            double latitude, double longitude, String today) {
        String date = session.optString("date", "");
        String id = session.optString("id", date);
        JSONObject limits = session.optJSONObject("limits");
        if (date.isEmpty() || id.isEmpty() || limits == null) return;
        if (date.compareTo(today) < 0) return; // The day has been and gone.

        String key = LAST_HOURS_PREFIX + id;
        try {
            String time = session.isNull("time") ? null : session.optString("time", null);
            int hours = suitableHours(latitude, longitude, date, limits, time);
            if (!prefs.contains(key)) {
                // First look at this session. The count the interface showed also
                // applies the offshore rule, which this cannot, so starting from
                // that number would report a change that never happened. Adopt
                // this count as the baseline instead and stay quiet.
                prefs.edit().putInt(key, hours).apply();
                return;
            }

            int lastTold = prefs.getInt(key, hours);
            boolean gone = hours == 0 && lastTold > 0;
            if (!gone && Math.abs(hours - lastTold) < MEANINGFUL_CHANGE) return;

            prefs.edit().putInt(key, hours).apply();
            notifyChange(context, session.optString("label", "Session"), date, time, id, hours, lastTold);
        } catch (JSONException | IOException failure) {
            Log.w(TAG, "Session check failed", failure);
        }
    }

    static boolean isWatching(Context context) {
        String raw = WidgetData.prefs(context).getString(KEY_PLAN, null);
        return raw != null && !raw.isEmpty();
    }

    /**
     * The widget's own updates only arrive while a widget is actually placed, so
     * a marked day gets its own repeating wake-up. Inexact on purpose: a forecast
     * that moved is worth hearing about today, not at a precise minute, and an
     * inexact alarm costs no special permission and little battery.
     *
     * Alarms do not survive a reboot; this is called again whenever the app is
     * opened or closed, which in practice re-arms it.
     */
    static void schedule(Context context) {
        android.app.AlarmManager alarms = context.getSystemService(android.app.AlarmManager.class);
        if (alarms == null) return;
        alarms.setInexactRepeating(android.app.AlarmManager.RTC,
                System.currentTimeMillis() + INTERVAL_MS, INTERVAL_MS, pendingRefresh(context));
    }

    static void cancel(Context context) {
        android.app.AlarmManager alarms = context.getSystemService(android.app.AlarmManager.class);
        if (alarms != null) alarms.cancel(pendingRefresh(context));
    }

    private static PendingIntent pendingRefresh(Context context) {
        Intent refresh = new Intent(context, WidgetProvider.class).setAction(WidgetProvider.ACTION_REFRESH);
        return PendingIntent.getBroadcast(context, 2, refresh,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Drops the running comparisons for sessions no longer in the list, and for
     * any whose plan was edited. Left alone, a deleted trip's baseline would sit
     * in preferences for good and be inherited by whatever reused its id.
     */
    static void reset(Context context, java.util.Set<String> keepIds) {
        SharedPreferences prefs = WidgetData.prefs(context);
        SharedPreferences.Editor editor = prefs.edit();
        for (String name : prefs.getAll().keySet()) {
            if (!name.startsWith(LAST_HOURS_PREFIX)) continue;
            if (!keepIds.contains(name.substring(LAST_HOURS_PREFIX.length()))) editor.remove(name);
        }
        editor.apply();
    }

    /** "Fri Sep 4", to match the day the app itself shows. */
    private static String readableDate(String date) {
        try {
            java.text.SimpleDateFormat iso = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US);
            return "on " + new java.text.SimpleDateFormat("EEE MMM d", java.util.Locale.US).format(iso.parse(date));
        } catch (java.text.ParseException unreadable) {
            return "on " + date;
        }
    }

    private static String today() {
        return new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
                .format(new java.util.Date());
    }

    private static double readDouble(SharedPreferences prefs, String key, double fallback) {
        String raw = prefs.getString(key, null);
        if (raw == null) return fallback;
        try {
            return Double.parseDouble(raw);
        } catch (NumberFormatException invalid) {
            return fallback;
        }
    }

    /**
     * Hours of the day that pass the limits — or, when an hour was named, 1 or 0
     * for that hour alone, since seven good hours are no comfort if none of them
     * is the one you are on the water.
     */
    private static int suitableHours(double latitude, double longitude, String date, JSONObject limits, String time)
            throws IOException, JSONException {
        JSONObject air = WidgetData.fetch("https://api.open-meteo.com/v1/forecast"
                + "?latitude=" + latitude + "&longitude=" + longitude
                + "&hourly=wind_speed_10m,wind_gusts_10m,is_day"
                + "&start_date=" + date + "&end_date=" + date
                + "&timezone=auto&wind_speed_unit=kn");
        JSONObject airHourly = air.optJSONObject("hourly");
        if (airHourly == null) return 0;

        JSONArray wave = null;
        JSONArray swell = null;
        JSONArray swellPeriod = null;
        JSONArray windWave = null;
        try {
            // The same wave models the app averages, so the two counts are made
            // of the same sea. Models outside their domain are dropped by the
            // API rather than failing the request.
            JSONObject sea = WidgetData.fetch("https://marine-api.open-meteo.com/v1/marine"
                    + "?latitude=" + latitude + "&longitude=" + longitude
                    + "&hourly=wave_height,swell_wave_height,swell_wave_period,wind_wave_height"
                    + "&start_date=" + date + "&end_date=" + date
                    + "&timezone=auto&models=" + WAVE_MODELS);
            JSONObject seaHourly = sea.optJSONObject("hourly");
            if (seaHourly != null) {
                wave = meanSeries(seaHourly, "wave_height");
                swell = meanSeries(seaHourly, "swell_wave_height");
                swellPeriod = meanSeries(seaHourly, "swell_wave_period");
                windWave = meanSeries(seaHourly, "wind_wave_height");
            }
        } catch (IOException | JSONException noSea) {
            // Inland or out of marine coverage; the wave limits simply cannot bite.
        }

        JSONArray wind = airHourly.optJSONArray("wind_speed_10m");
        JSONArray gust = airHourly.optJSONArray("wind_gusts_10m");
        JSONArray day = airHourly.optJSONArray("is_day");
        JSONArray stamps = airHourly.optJSONArray("time");
        int length = wind == null ? 0 : wind.length();

        int only = time == null ? -1 : indexOfHour(stamps, date, time);
        if (time != null && only < 0) return 0;

        int count = 0;
        for (int i = 0; i < length; i++) {
            if (only >= 0 && i != only) continue;
            if (fits(limits, at(wind, i), at(gust, i), at(wave, i), at(day, i),
                    at(swell, i), at(swellPeriod, i), at(windWave, i))) count++;
        }
        return count;
    }

    /** Open-Meteo stamps are "2026-09-04T09:00" in the location's own clock. */
    private static int indexOfHour(JSONArray stamps, String date, String time) {
        if (stamps == null || time.length() < 2) return -1;
        String target = date + "T" + time.substring(0, 2) + ":00";
        for (int i = 0; i < stamps.length(); i++) {
            if (target.equals(stamps.optString(i, null))) return i;
        }
        return -1;
    }

    /**
     * Averages the per-model series the marine API returns as wave_height_gwam,
     * wave_height_ewam and so on, matching what the app shows. Nothing is
     * invented: an hour no model answered for stays null.
     *
     * Android's JSONArray.put(double) rejects NaN and infinity rather than
     * storing them, which is the JSONException here; the caller already handles
     * it by leaving the plan unchecked this round rather than guessing.
     */
    private static JSONArray meanSeries(JSONObject hourly, String key) throws JSONException {
        java.util.List<JSONArray> members = new java.util.ArrayList<>();
        for (java.util.Iterator<String> names = hourly.keys(); names.hasNext(); ) {
            String name = names.next();
            if (!name.startsWith(key + "_")) continue;
            JSONArray series = hourly.optJSONArray(name);
            if (series != null) members.add(series);
        }
        if (members.isEmpty()) return null;

        int length = 0;
        for (JSONArray series : members) length = Math.max(length, series.length());
        JSONArray mean = new JSONArray();
        for (int i = 0; i < length; i++) {
            double total = 0;
            int seen = 0;
            for (JSONArray series : members) {
                Double value = at(series, i);
                if (value == null) continue;
                total += value;
                seen++;
            }
            if (seen == 0) mean.put(JSONObject.NULL);
            else mean.put(total / seen);
        }
        return mean;
    }

    private static Double at(JSONArray array, int index) {
        if (array == null || index >= array.length() || array.isNull(index)) return null;
        double value = array.optDouble(index, Double.NaN);
        return Double.isNaN(value) ? null : value;
    }

    private static boolean fits(JSONObject limits, Double wind, Double gust, Double wave, Double isDay,
            Double swell, Double swellPeriod, Double windWave) {
        if (limits.optBoolean("daylight", false) && (isDay == null || isDay < 0.5)) return false;
        if (limits.has("swellMin") && (swell == null || swell < limits.optDouble("swellMin"))) return false;
        if (limits.has("swellMax") && (swell == null || swell >= limits.optDouble("swellMax"))) return false;
        if (limits.has("swellPeriodMin") && (swellPeriod == null ? 0 : swellPeriod) < limits.optDouble("swellPeriodMin")) return false;
        if (limits.has("windWaveMax") && (windWave == null ? 0 : windWave) >= limits.optDouble("windWaveMax")) return false;
        if (limits.has("waveMin") && (wave == null || wave < limits.optDouble("waveMin"))) return false;
        if (limits.has("waveMax") && (wave == null || wave >= limits.optDouble("waveMax"))) return false;
        if (limits.has("windMin") && (wind == null || wind < limits.optDouble("windMin"))) return false;
        if (limits.has("windMax") && (wind == null || wind > limits.optDouble("windMax"))) return false;
        if (limits.has("gustMax") && (gust == null ? 0 : gust) >= limits.optDouble("gustMax")) return false;
        return true;
    }

    private static void notifyChange(Context context, String label, String date, String time,
            String id, int hours, int baseline) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        manager.createNotificationChannel(new NotificationChannel(
                CHANNEL, "Planned days", NotificationManager.IMPORTANCE_DEFAULT));

        // Which way it moved, said outright. A lock screen is read in a glance
        // and "5 h, was 7" makes you do the subtraction yourself.
        String when = label + " " + readableDate(date) + (time == null ? "" : " at " + time);
        String headline;
        if (hours == 0) {
            headline = when + (time == null ? " no longer suits" : " no longer suits that hour");
        } else if (time != null) {
            // With an hour named the count is 1 or 0, so a rise means it is back on.
            headline = when + " suits again";
        } else {
            headline = (hours < baseline ? when + " is getting worse" : when + " is improving")
                    + " — " + hours + " h, was " + baseline;
        }
        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        Notification notification = new Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(headline)
                .setContentText("Open WeatherDeck for the full picture.")
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(context, Math.abs(id.hashCode() % 1000), open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                .build();
        // One notification per session, so a second trip turning cannot silently
        // replace the first one's alert.
        manager.notify(NOTIFICATION_ID + Math.abs(id.hashCode() % 1000), notification);
    }
}
