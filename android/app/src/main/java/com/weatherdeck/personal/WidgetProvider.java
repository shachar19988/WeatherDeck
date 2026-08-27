package com.weatherdeck.personal;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import java.text.DateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The 2x2 home-screen widget: today's temperature, wind and wave ranges over a
 * scene coloured by how much wind the day holds.
 *
 * Deliberately static. A widget that animates has to be redrawn to move, and
 * paying battery for motion nobody is watching is a bad trade — the colour does
 * the work instead. The system's own updatePeriodMillis drives a three-hourly
 * refresh without waking the device, and the app pushes one every time it is
 * closed, so in practice it is fresh whenever it matters.
 *
 * Refresh runs on a background thread held open by goAsync(), so there is no
 * scheduling library and the project keeps its zero runtime dependencies.
 */
public class WidgetProvider extends AppWidgetProvider {
    static final String ACTION_REFRESH = "com.weatherdeck.personal.WIDGET_REFRESH";
    private static final String TAG = "WeatherDeckWidget";
    private static final ExecutorService WORKERS = Executors.newSingleThreadExecutor();
    private static final long STALE_AFTER_MS = 6L * 60L * 60L * 1000L;
    private static final int FALLBACK_DP = 110;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        renderAll(context, manager, widgetIds);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager manager, int widgetId, Bundle options) {
        super.onAppWidgetOptionsChanged(context, manager, widgetId, options);
        renderAll(context, manager, new int[]{widgetId});
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        boolean wanted = AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action) || ACTION_REFRESH.equals(action);
        if (!wanted) return;

        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        final int[] widgetIds = manager.getAppWidgetIds(new ComponentName(context, WidgetProvider.class));
        // A marked day is watched whether or not a widget is on the home screen,
        // so an empty widget list is not on its own a reason to do nothing.
        if (widgetIds.length == 0 && !PlanWatch.isWatching(context)) return;

        final PendingResult pending = goAsync();
        final Context application = context.getApplicationContext();
        WORKERS.execute(() -> {
            try {
                if (widgetIds.length > 0) {
                    WidgetData.refresh(application);
                    renderAll(application, AppWidgetManager.getInstance(application), widgetIds);
                }
                PlanWatch.check(application);
            } catch (Throwable failure) {
                // Nothing here may be allowed to fail silently: a widget that
                // renders empty text looks broken and says nothing about why.
                Log.w(TAG, "Widget refresh failed", failure);
            } finally {
                pending.finish();
            }
        });
    }

    /** Called by the app when the chosen location changes or the app is closed. */
    static void requestRefresh(Context context) {
        context.sendBroadcast(new Intent(context, WidgetProvider.class).setAction(ACTION_REFRESH));
    }

    private static void renderAll(Context context, AppWidgetManager manager, int[] widgetIds) {
        WidgetData data = WidgetData.load(context);
        for (int widgetId : widgetIds) {
            try {
                int dp = widgetDp(manager, widgetId);
                float density = context.getResources().getDisplayMetrics().density;
                int sceneSize = WidgetRenderer.clampSize(Math.round(dp * density));
                manager.updateAppWidget(widgetId, build(context, data, sceneSize, dp / (float) FALLBACK_DP));
            } catch (Throwable failure) {
                Log.w(TAG, "Widget render failed", failure);
            }
        }
    }

    /**
     * The widget's own size in dp. Used both to draw the scene at its real pixel
     * size, rather than drawing small and letting the launcher stretch it, and to
     * scale the type so a resized widget stays readable instead of keeping the
     * text it had at 2x2.
     */
    private static int widgetDp(AppWidgetManager manager, int widgetId) {
        try {
            Bundle options = manager.getAppWidgetOptions(widgetId);
            if (options != null) {
                int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0);
                int height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
                return Math.max(Math.max(width, height), FALLBACK_DP);
            }
        } catch (Throwable ignored) {
            // Some launchers hand back nothing useful; the fallback covers a 2x2.
        }
        return FALLBACK_DP;
    }

    private static RemoteViews build(Context context, WidgetData data, int sceneSize, float typeScale) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget);
        try {
            Bitmap scene = WidgetRenderer.scene(data, sceneSize);
            views.setImageViewBitmap(R.id.widget_scene, scene);
        } catch (Throwable failure) {
            // The layout's own background keeps the widget legible without art.
            Log.w(TAG, "Scene render failed", failure);
        }

        views.setTextViewText(R.id.widget_place, data.place);
        views.setTextViewText(R.id.widget_temp, range(data.tempLow, data.tempHigh, "°", 0));
        views.setTextViewText(R.id.widget_sea, seaLine(data));
        views.setTextViewText(R.id.widget_updated, updatedLabel(data));

        // Today stays the widget's subject; a planned session is a note under it.
        String session = PlanWatch.nextNote(context);
        views.setViewVisibility(R.id.widget_session, session == null ? View.GONE : View.VISIBLE);
        if (session != null) views.setTextViewText(R.id.widget_session, session);

        float scale = Math.max(0.9f, Math.min(1.8f, typeScale));
        setSize(views, R.id.widget_place, 13f * scale);
        setSize(views, R.id.widget_session, 11f * scale);
        setSize(views, R.id.widget_temp, 34f * scale);
        setSize(views, R.id.widget_sea, 15f * scale);
        setSize(views, R.id.widget_updated, 11f * scale);

        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(
                context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return views;
    }

    private static void setSize(RemoteViews views, int viewId, float sp) {
        views.setTextViewTextSize(viewId, TypedValue.COMPLEX_UNIT_SP, sp);
    }

    /**
     * Wind and sea on one line, spelled as tightly as they can be read.
     *
     * A 2x2 is about 150dp across and the previous spacing did not fit, so the
     * sea silently fell off the end — the widget looked like it had no wave data
     * when it had it all along. Units lose their leading space and the separator
     * loses its padding, which buys the eight characters the sea needs.
     */
    private static String seaLine(WidgetData data) {
        String wind = range(data.windLow, data.windHigh, "kt", 0);
        String wave = range(data.waveLow, data.waveHigh, "m", 1);
        return "—".equals(wave) ? wind : wind + " · " + wave;
    }

    /** Missing readings stay missing — the widget never invents a number. */
    private static String range(double low, double high, String unit, int decimals) {
        if (!WidgetData.has(low) || !WidgetData.has(high)) return "—";
        String from = String.format(Locale.US, "%." + decimals + "f", low);
        String to = String.format(Locale.US, "%." + decimals + "f", high);
        return from.equals(to) ? from + unit : from + "-" + to + unit;
    }

    private static String updatedLabel(WidgetData data) {
        if (data.updatedAt <= 0L) return "No reading yet — tap to open";
        String time = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(data.updatedAt));
        boolean stale = System.currentTimeMillis() - data.updatedAt > STALE_AFTER_MS;
        return (stale ? "Last reading " : "Updated ") + time;
    }
}
