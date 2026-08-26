package com.weatherdeck.personal;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import java.text.DateFormat;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The 4x4 home-screen widget: today's temperature, wave and wind ranges over an
 * animated scene that follows the current conditions.
 *
 * Refresh runs on a background thread held open by goAsync(), so no scheduling
 * library is needed; the system's own updatePeriodMillis drives the cadence.
 * Cached readings render immediately, so the widget is never blank while the
 * network is being waited on.
 */
public class WidgetProvider extends AppWidgetProvider {
    static final String ACTION_REFRESH = "com.weatherdeck.personal.WIDGET_REFRESH";
    private static final ExecutorService WORKERS = Executors.newSingleThreadExecutor();
    private static final long STALE_AFTER_MS = 6L * 60L * 60L * 1000L;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        WidgetData data = WidgetData.load(context);
        for (int widgetId : widgetIds) {
            manager.updateAppWidget(widgetId, build(context, data));
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        boolean wanted = AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action) || ACTION_REFRESH.equals(action);
        if (!wanted || ids(context).length == 0) return;

        final PendingResult pending = goAsync();
        final Context application = context.getApplicationContext();
        WORKERS.execute(() -> {
            try {
                WidgetData.refresh(application);
                renderAll(application);
            } finally {
                pending.finish();
            }
        });
    }

    /** Called by the app when the chosen location changes. */
    static void requestRefresh(Context context) {
        Intent intent = new Intent(context, WidgetProvider.class).setAction(ACTION_REFRESH);
        context.sendBroadcast(intent);
    }

    private static int[] ids(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        return manager.getAppWidgetIds(new ComponentName(context, WidgetProvider.class));
    }

    private static void renderAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        WidgetData data = WidgetData.load(context);
        for (int widgetId : ids(context)) {
            manager.updateAppWidget(widgetId, build(context, data));
        }
    }

    private static RemoteViews build(Context context, WidgetData data) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget);
        int[] frames = {R.id.widget_frame_0, R.id.widget_frame_1, R.id.widget_frame_2};
        for (int i = 0; i < frames.length && i < WidgetRenderer.FRAMES; i++) {
            views.setImageViewBitmap(frames[i], WidgetRenderer.frame(data, i));
        }

        views.setTextViewText(R.id.widget_place, data.place);
        views.setTextViewText(R.id.widget_temp, range(data.tempLow, data.tempHigh, "°", 0));
        views.setTextViewText(R.id.widget_wind, range(data.windLow, data.windHigh, " kt", 0));
        views.setTextViewText(R.id.widget_wave, range(data.waveLow, data.waveHigh, " m", 1));
        views.setTextViewText(R.id.widget_updated, updatedLabel(data));

        Intent open = new Intent(context, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(
                context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return views;
    }

    /** Missing readings stay missing — the widget never invents a number. */
    private static String range(double low, double high, String unit, int decimals) {
        if (!WidgetData.has(low) || !WidgetData.has(high)) return "—";
        String from = String.format(java.util.Locale.US, "%." + decimals + "f", low);
        String to = String.format(java.util.Locale.US, "%." + decimals + "f", high);
        return from.equals(to) ? from + unit : from + "–" + to + unit;
    }

    private static String updatedLabel(WidgetData data) {
        if (data.updatedAt <= 0L) return "No reading yet";
        String time = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(data.updatedAt));
        boolean stale = System.currentTimeMillis() - data.updatedAt > STALE_AFTER_MS;
        return (stale ? "Last reading " : "Updated ") + time;
    }
}
