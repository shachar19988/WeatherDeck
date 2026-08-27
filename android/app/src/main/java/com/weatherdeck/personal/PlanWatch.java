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

    static final String KEY_PLAN = "plan";
    private static final String KEY_LAST_HOURS = "planLastHours";

    private PlanWatch() {
    }

    /** Blocking. Called only from the widget's background thread. */
    static void check(Context context) {
        SharedPreferences prefs = WidgetData.prefs(context);
        String raw = prefs.getString(KEY_PLAN, null);
        if (raw == null || raw.isEmpty()) return;

        try {
            JSONObject plan = new JSONObject(raw);
            String date = plan.optString("date", "");
            if (date.isEmpty()) return;

            double latitude = readDouble(prefs, WidgetData.KEY_LAT, 32.794);
            double longitude = readDouble(prefs, WidgetData.KEY_LON, 34.9896);
            JSONObject limits = plan.optJSONObject("limits");
            if (limits == null) return;

            if (date.compareTo(today()) < 0) return; // The day has been and gone.

            int hours = suitableHours(latitude, longitude, date, limits);
            if (!prefs.contains(KEY_LAST_HOURS)) {
                // First look at this plan. The count the interface showed also
                // applies the offshore rule, which this cannot, so starting from
                // that number would report a change that never happened. Adopt
                // this count as the baseline instead and stay quiet.
                prefs.edit().putInt(KEY_LAST_HOURS, hours).apply();
                return;
            }

            int lastTold = prefs.getInt(KEY_LAST_HOURS, hours);
            boolean gone = hours == 0 && lastTold > 0;
            if (!gone && Math.abs(hours - lastTold) < MEANINGFUL_CHANGE) return;

            prefs.edit().putInt(KEY_LAST_HOURS, hours).apply();
            notifyChange(context, plan.optString("label", "Plan"), date, hours, lastTold);
        } catch (JSONException | IOException failure) {
            Log.w(TAG, "Plan check failed", failure);
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

    /** Clears the running comparison so a newly marked day starts from its own baseline. */
    static void reset(Context context) {
        WidgetData.prefs(context).edit().remove(KEY_LAST_HOURS).apply();
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

    private static int suitableHours(double latitude, double longitude, String date, JSONObject limits)
            throws IOException, JSONException {
        JSONObject air = WidgetData.fetch("https://api.open-meteo.com/v1/forecast"
                + "?latitude=" + latitude + "&longitude=" + longitude
                + "&hourly=wind_speed_10m,wind_gusts_10m,is_day"
                + "&start_date=" + date + "&end_date=" + date
                + "&timezone=auto&wind_speed_unit=kn");
        JSONObject airHourly = air.optJSONObject("hourly");
        if (airHourly == null) return 0;

        JSONArray wave = null;
        try {
            JSONObject sea = WidgetData.fetch("https://marine-api.open-meteo.com/v1/marine"
                    + "?latitude=" + latitude + "&longitude=" + longitude
                    + "&hourly=wave_height&start_date=" + date + "&end_date=" + date + "&timezone=auto");
            JSONObject seaHourly = sea.optJSONObject("hourly");
            if (seaHourly != null) wave = seaHourly.optJSONArray("wave_height");
        } catch (IOException | JSONException noSea) {
            // Inland or out of marine coverage; the wave limits simply cannot bite.
        }

        JSONArray wind = airHourly.optJSONArray("wind_speed_10m");
        JSONArray gust = airHourly.optJSONArray("wind_gusts_10m");
        JSONArray day = airHourly.optJSONArray("is_day");
        int length = wind == null ? 0 : wind.length();
        int count = 0;
        for (int i = 0; i < length; i++) {
            if (fits(limits, at(wind, i), at(gust, i), at(wave, i), at(day, i))) count++;
        }
        return count;
    }

    private static Double at(JSONArray array, int index) {
        if (array == null || index >= array.length() || array.isNull(index)) return null;
        double value = array.optDouble(index, Double.NaN);
        return Double.isNaN(value) ? null : value;
    }

    private static boolean fits(JSONObject limits, Double wind, Double gust, Double wave, Double isDay) {
        if (limits.optBoolean("daylight", false) && (isDay == null || isDay < 0.5)) return false;
        if (limits.has("waveMin") && (wave == null || wave < limits.optDouble("waveMin"))) return false;
        if (limits.has("waveMax") && (wave == null || wave >= limits.optDouble("waveMax"))) return false;
        if (limits.has("windMin") && (wind == null || wind < limits.optDouble("windMin"))) return false;
        if (limits.has("windMax") && (wind == null || wind > limits.optDouble("windMax"))) return false;
        if (limits.has("gustMax") && (gust == null ? 0 : gust) >= limits.optDouble("gustMax")) return false;
        return true;
    }

    private static void notifyChange(Context context, String label, String date, int hours, int baseline) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        manager.createNotificationChannel(new NotificationChannel(
                CHANNEL, "Planned days", NotificationManager.IMPORTANCE_DEFAULT));

        String headline = hours == 0
                ? label + " on " + date + " no longer suits"
                : label + " on " + date + ": " + hours + " h now, was " + baseline;
        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        Notification notification = new Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(headline)
                .setContentText("Open WeatherDeck for the full picture.")
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(context, 1, open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE))
                .build();
        manager.notify(NOTIFICATION_ID, notification);
    }
}
