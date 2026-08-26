package com.weatherdeck.personal;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;

/**
 * Draws the widget's background scene.
 *
 * Home-screen widgets run on RemoteViews, which has no property animators and no
 * animated drawables — continuous animation is not available. What is available
 * is ViewFlipper, which the system cycles through a handful of child views on its
 * own. So the motion here is a short loop: each frame is the same scene with its
 * clouds, rain and swell advanced by one step, and the flipper plays them.
 *
 * RGB_565 at this size keeps all three frames well inside the RemoteViews
 * transaction limit; the readings themselves are real TextViews on top, so they
 * stay sharp and cost nothing to redraw.
 */
final class WidgetRenderer {
    static final int FRAMES = 3;
    // Three RGB_565 frames at this size are ~400 kB in total, comfortably inside
    // the RemoteViews transaction limit that a larger ARGB_8888 set would breach.
    private static final int SIZE = 256;

    private WidgetRenderer() {
    }

    static Bitmap frame(WidgetData data, int frame) {
        Bitmap bitmap = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.RGB_565);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

        Group group = groupOf(data.weatherCode);
        drawSky(canvas, paint, group, data.isDay);
        float drift = (float) frame / FRAMES;

        if (group == Group.CLEAR || group == Group.PARTLY) {
            drawOrb(canvas, paint, data.isDay);
        }
        if (group != Group.CLEAR) {
            drawClouds(canvas, paint, group, drift);
        }
        if (group == Group.RAIN || group == Group.STORM) {
            drawRain(canvas, paint, frame, group == Group.STORM);
        }
        if (group == Group.SNOW) {
            drawSnow(canvas, paint, frame);
        }
        drawSwell(canvas, paint, data, drift);
        return bitmap;
    }

    private enum Group { CLEAR, PARTLY, CLOUD, FOG, RAIN, SNOW, STORM }

    private static Group groupOf(int code) {
        if (code < 0) return Group.PARTLY;
        if (code == 0) return Group.CLEAR;
        if (code == 1 || code == 2) return Group.PARTLY;
        if (code == 3) return Group.CLOUD;
        if (code == 45 || code == 48) return Group.FOG;
        if (code >= 95) return Group.STORM;
        if ((code >= 71 && code <= 77) || code == 85 || code == 86) return Group.SNOW;
        if (code >= 51) return Group.RAIN;
        return Group.PARTLY;
    }

    private static void drawSky(Canvas canvas, Paint paint, Group group, boolean isDay) {
        int top;
        int bottom = 0xFF07171F;
        if (!isDay) {
            top = group == Group.STORM ? 0xFF181B2A : 0xFF10263A;
        } else {
            switch (group) {
                case CLEAR: top = 0xFF1E6E8C; break;
                case PARTLY: top = 0xFF1D5F7A; break;
                case STORM: top = 0xFF2A2E3D; break;
                case RAIN: top = 0xFF243D4A; break;
                case SNOW: top = 0xFF3A4A55; break;
                case FOG: top = 0xFF33454E; break;
                default: top = 0xFF244452; break;
            }
        }
        paint.setShader(new LinearGradient(0, 0, 0, SIZE, top, bottom, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, SIZE, SIZE, paint);
        paint.setShader(null);
    }

    private static void drawOrb(Canvas canvas, Paint paint, boolean isDay) {
        paint.setColor(isDay ? 0xFFFFD68A : 0xFFD8E4E7);
        paint.setAlpha(isDay ? 235 : 200);
        canvas.drawCircle(SIZE * 0.74f, SIZE * 0.24f, SIZE * 0.11f, paint);
        if (!isDay) {
            // Bite a crescent out of the moon with the sky's own colour.
            paint.setColor(0xFF10263A);
            canvas.drawCircle(SIZE * 0.79f, SIZE * 0.20f, SIZE * 0.10f, paint);
        }
        paint.setAlpha(255);
    }

    private static void drawClouds(Canvas canvas, Paint paint, Group group, float drift) {
        int tint;
        switch (group) {
            case STORM: tint = 0xFF3C4152; break;
            case RAIN: tint = 0xFF52646E; break;
            case FOG: tint = 0xFF6C7B84; break;
            case SNOW: tint = 0xFF8A99A3; break;
            case PARTLY: tint = 0xFF6E8A98; break;
            default: tint = 0xFF5E7480; break;
        }
        paint.setColor(tint);
        int count = group == Group.PARTLY ? 2 : 3;
        for (int i = 0; i < count; i++) {
            float phase = (drift + i * 0.37f) % 1f;
            float cx = -SIZE * 0.2f + phase * SIZE * 1.4f;
            float cy = SIZE * (0.20f + i * 0.11f);
            float scale = 0.9f - i * 0.14f;
            paint.setAlpha(200 - i * 35);
            canvas.drawCircle(cx, cy, SIZE * 0.11f * scale, paint);
            canvas.drawCircle(cx + SIZE * 0.09f * scale, cy - SIZE * 0.04f * scale, SIZE * 0.13f * scale, paint);
            canvas.drawCircle(cx + SIZE * 0.20f * scale, cy, SIZE * 0.10f * scale, paint);
            canvas.drawRect(cx, cy, cx + SIZE * 0.20f * scale, cy + SIZE * 0.10f * scale, paint);
        }
        paint.setAlpha(255);
    }

    private static void drawRain(Canvas canvas, Paint paint, int frame, boolean heavy) {
        paint.setColor(heavy ? 0xFF9FD8FF : 0xFF7FB6D8);
        paint.setStrokeWidth(SIZE * 0.008f);
        paint.setAlpha(heavy ? 210 : 170);
        int drops = heavy ? 26 : 16;
        for (int i = 0; i < drops; i++) {
            float x = ((i * 37) % 100) / 100f * SIZE;
            float base = ((i * 53) % 100) / 100f;
            float y = SIZE * 0.38f + ((base + frame / (float) FRAMES) % 1f) * SIZE * 0.42f;
            canvas.drawLine(x, y, x - SIZE * 0.018f, y + SIZE * 0.055f, paint);
        }
        paint.setAlpha(255);
    }

    private static void drawSnow(Canvas canvas, Paint paint, int frame) {
        paint.setColor(0xFFEDF6F7);
        paint.setAlpha(200);
        for (int i = 0; i < 20; i++) {
            float x = ((i * 41) % 100) / 100f * SIZE;
            float base = ((i * 61) % 100) / 100f;
            float y = SIZE * 0.36f + ((base + frame / (float) FRAMES) % 1f) * SIZE * 0.44f;
            canvas.drawCircle(x, y, SIZE * 0.011f, paint);
        }
        paint.setAlpha(255);
    }

    /** A swell line whose height follows the day's waves, so the sea is real data. */
    private static void drawSwell(Canvas canvas, Paint paint, WidgetData data, float drift) {
        float metres = WidgetData.has(data.waveHigh) ? (float) data.waveHigh : 0f;
        float amplitude = Math.min(SIZE * 0.05f, SIZE * 0.012f + metres * SIZE * 0.016f);
        float baseline = SIZE * 0.84f;

        for (int layer = 0; layer < 2; layer++) {
            Path path = new Path();
            float offset = drift * SIZE * 0.5f + layer * SIZE * 0.18f;
            float lift = baseline + layer * SIZE * 0.05f;
            path.moveTo(0, SIZE);
            path.lineTo(0, lift);
            for (float x = 0; x <= SIZE; x += SIZE / 32f) {
                double wave = Math.sin((x + offset) / (SIZE * 0.16f));
                path.lineTo(x, lift + (float) wave * amplitude);
            }
            path.lineTo(SIZE, SIZE);
            path.close();
            paint.setColor(layer == 0 ? 0xFF123A44 : 0xFF0B2831);
            paint.setAlpha(layer == 0 ? 235 : 255);
            canvas.drawPath(path, paint);
        }
        paint.setAlpha(255);
    }
}
