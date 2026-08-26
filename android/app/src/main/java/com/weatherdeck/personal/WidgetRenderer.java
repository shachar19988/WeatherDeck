package com.weatherdeck.personal;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.Shader;

/**
 * Draws the widget's scene: a saturated field with one soft orb and a low swell,
 * coloured by how much wind the day holds.
 *
 * The colour carries the information. Two days with the same sky but 6 kt and
 * 32 kt of wind are not the same day, so the palette follows the wind bands the
 * forecast table already uses — green through amber to red — and the widget
 * answers "can I go out today" before any number is read.
 *
 * Drawn at the widget's real pixel size in ARGB_8888. RGB_565 would halve the
 * memory but a smooth radial gradient in five and six bits per channel bands
 * visibly, which is exactly the cheap look this design cannot afford.
 */
final class WidgetRenderer {
    /** Above this the RemoteViews payload gets uncomfortable; 320px covers a 2x2 at 3x density. */
    private static final int MAX_SIZE = 320;
    private static final int MIN_SIZE = 120;

    // skyInner, skyMid, skyOuter, orbInner, orbOuter — one row per wind band.
    private static final int[][] PALETTE = {
            {0xFF2FBFA4, 0xFF127E8E, 0xFF0A3350, 0xFFEAFFF6, 0xFF5FE0C0},
            {0xFF8FD14A, 0xFF1D8F7A, 0xFF0D3352, 0xFFF6FFE0, 0xFFB8E75F},
            {0xFFF2A93C, 0xFFC8623A, 0xFF3A1A45, 0xFFFFF0E2, 0xFFFFB07A},
            {0xFFFF9A5C, 0xFFC8323F, 0xFF3B1140, 0xFFFFF0E2, 0xFFFF8F6E},
    };

    private WidgetRenderer() {
    }

    static int clampSize(int requested) {
        return Math.max(MIN_SIZE, Math.min(MAX_SIZE, requested));
    }

    static Bitmap scene(WidgetData data, int requestedSize) {
        int size = clampSize(requestedSize);
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setDither(true);

        int[] palette = PALETTE[bandOf(data)];
        float night = data.isDay ? 1f : 0.62f;

        paint.setShader(new RadialGradient(
                size * 0.28f, size * 0.18f, size * 1.05f,
                new int[]{dim(palette[0], night), dim(palette[1], night), dim(palette[2], night)},
                new float[]{0f, 0.46f, 1f},
                Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, size, size, paint);
        paint.setShader(null);

        drawOrb(canvas, paint, size, palette, night);
        if (raining(data.weatherCode)) drawRain(canvas, paint, size, data.weatherCode >= 95);
        drawSwell(canvas, paint, data, size, palette, night);
        return bitmap;
    }

    /** Four bands is the right resolution at this size; the table carries all seven. */
    private static int bandOf(WidgetData data) {
        double wind = WidgetData.has(data.windHigh) ? data.windHigh : 0;
        if (wind < 10) return 0;
        if (wind < 20) return 1;
        if (wind < 30) return 2;
        return 3;
    }

    private static boolean raining(int code) {
        return code >= 51 && code != 71 && code != 73 && code != 75 && code != 77;
    }

    private static int dim(int color, float factor) {
        if (factor >= 1f) return color;
        return Color.argb(
                Color.alpha(color),
                Math.round(Color.red(color) * factor),
                Math.round(Color.green(color) * factor),
                Math.round(Color.blue(color) * factor));
    }

    /**
     * The softness comes from the gradient itself plus one wide, very faint halo.
     * There is no blur available here, and none is needed.
     */
    private static void drawOrb(Canvas canvas, Paint paint, int size, int[] palette, float night) {
        float cx = size * 0.78f;
        float cy = size * 0.78f;

        paint.setColor(Color.WHITE);
        paint.setAlpha(18);
        canvas.drawCircle(cx - size * 0.02f, cy - size * 0.02f, size * 0.33f, paint);
        paint.setAlpha(255);

        paint.setShader(new RadialGradient(
                cx - size * 0.06f, cy - size * 0.07f, size * 0.26f,
                dim(palette[3], night), dim(palette[4], night),
                Shader.TileMode.CLAMP));
        paint.setAlpha(night >= 1f ? 235 : 200);
        canvas.drawCircle(cx, cy, size * 0.23f, paint);
        paint.setShader(null);
        paint.setAlpha(255);
    }

    private static void drawRain(Canvas canvas, Paint paint, int size, boolean heavy) {
        paint.setColor(0xFFFFFFFF);
        paint.setAlpha(heavy ? 150 : 110);
        paint.setStrokeWidth(Math.max(1f, size * 0.007f));
        int drops = heavy ? 22 : 14;
        for (int i = 0; i < drops; i++) {
            float x = ((i * 37) % 100) / 100f * size;
            float y = ((i * 53) % 100) / 100f * size * 0.7f;
            canvas.drawLine(x, y, x - size * 0.02f, y + size * 0.06f, paint);
        }
        paint.setAlpha(255);
    }

    /** The swell height is real data: the day's biggest wave sets the amplitude. */
    private static void drawSwell(Canvas canvas, Paint paint, WidgetData data, int size, int[] palette, float night) {
        float metres = WidgetData.has(data.waveHigh) ? (float) data.waveHigh : 0f;
        float amplitude = Math.min(size * 0.05f, size * 0.012f + metres * size * 0.015f);
        int deep = dim(palette[2], night);

        for (int layer = 0; layer < 2; layer++) {
            Path path = new Path();
            float lift = size * (0.86f + layer * 0.05f);
            float offset = layer * size * 0.2f;
            path.moveTo(0, size);
            path.lineTo(0, lift);
            for (float x = 0; x <= size; x += size / 40f) {
                path.lineTo(x, lift + (float) Math.sin((x + offset) / (size * 0.17f)) * amplitude);
            }
            path.lineTo(size, size);
            path.close();
            paint.setColor(deep);
            paint.setAlpha(layer == 0 ? 150 : 235);
            canvas.drawPath(path, paint);
        }
        paint.setAlpha(255);
    }
}
