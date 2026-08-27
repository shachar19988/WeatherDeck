package com.weatherdeck.personal;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;

/**
 * Thin wrapper around the Vite build. The build output in dist/ is packaged as
 * app assets and served over a private https origin, so the page behaves
 * exactly as it does on the web: a real origin, working relative URLs, storage
 * and a service worker.
 */
public class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_ORIGIN = "https://" + APP_HOST;
    private static final int LOCATION_REQUEST = 100;
    private static final int NOTIFICATION_REQUEST = 101;
    private static final int READY_POLL_MS = 100;
    private static final int READY_ATTEMPTS = 40;
    private static final long WIDGET_REFRESH_AFTER_MS = 30L * 60L * 1000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private TextView statusView;
    private String lastConsoleError = "";
    private GeolocationPermissions.Callback pendingGeolocation;
    private String pendingGeolocationOrigin;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(7, 23, 31));
        statusView = new TextView(this);
        statusView.setText("Starting WeatherDeck…");
        statusView.setTextColor(Color.rgb(237, 246, 247));
        statusView.setTextSize(18);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(32, 32, 32, 32);
        root.addView(statusView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(7, 23, 31));
        webView.setVisibility(View.INVISIBLE);
        root.addView(webView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serveAsset(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (APP_HOST.equals(uri.getHost()) || !request.isForMainFrame()) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    // No browser installed; simply do not navigate.
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pollForInterface(0);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showFailure("Loading error: " + error.getDescription());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) lastConsoleError = message.message();
                return false;
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                grantGeolocation(origin, callback);
            }
        });

        // The service worker fetches through its own client, not the page's.
        ServiceWorkerController serviceWorkers = ServiceWorkerController.getInstance();
        serviceWorkers.setServiceWorkerClient(new ServiceWorkerClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return serveAsset(request.getUrl());
            }
        });

        webView.loadUrl(APP_ORIGIN + "/index.html");
    }

    /** Serves dist/ out of app assets for our own origin; anything else goes to the network. */
    private WebResourceResponse serveAsset(Uri uri) {
        if (uri == null || !APP_HOST.equals(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        String assetPath = path.substring(1);
        if (assetPath.contains("..")) return notFound();
        try {
            InputStream input = getAssets().open(assetPath);
            String mime = mimeTypeOf(assetPath);
            String encoding = mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript") || mime.contains("svg") ? "UTF-8" : null;
            return new WebResourceResponse(mime, encoding, 200, "OK", Collections.emptyMap(), input);
        } catch (IOException missing) {
            return notFound();
        }
    }

    private WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeTypeOf(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".webmanifest")) return "application/manifest+json";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".webp")) return "image/webp";
        if (path.endsWith(".woff2")) return "font/woff2";
        if (path.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    /**
     * React mounts after the load event, so a single check right at onPageFinished
     * reports a healthy app as broken on slower devices. Poll instead.
     */
    private void pollForInterface(final int attempt) {
        if (webView == null) return;
        webView.evaluateJavascript(
                "(function(){var r=document.getElementById('root');return !!r&&r.childElementCount>0})()",
                value -> {
                    if (webView == null) return;
                    if ("true".equals(value)) {
                        webView.setVisibility(View.VISIBLE);
                        statusView.setVisibility(View.GONE);
                        syncWidgetLocation();
                        syncPlan();
                    } else if (attempt < READY_ATTEMPTS) {
                        handler.postDelayed(() -> pollForInterface(attempt + 1), READY_POLL_MS);
                    } else {
                        showFailure("The interface did not start." + (lastConsoleError.isEmpty() ? "" : "\n\n" + lastConsoleError));
                    }
                });
    }

    /** Only our own origin may ask for location, and only after Android agrees. */
    private void grantGeolocation(String origin, GeolocationPermissions.Callback callback) {
        if (origin == null || !origin.startsWith(APP_ORIGIN)) {
            if (callback != null) callback.invoke(origin, false, false);
            return;
        }
        boolean granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            callback.invoke(origin, true, false);
            return;
        }
        pendingGeolocationOrigin = origin;
        pendingGeolocation = callback;
        requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_REQUEST) {
            // Answered either way, the page should stop guessing.
            reportNotificationState();
            return;
        }
        if (requestCode != LOCATION_REQUEST || pendingGeolocation == null) return;
        boolean granted = false;
        for (int result : grantResults) {
            if (result == PackageManager.PERMISSION_GRANTED) granted = true;
        }
        pendingGeolocation.invoke(pendingGeolocationOrigin, granted, false);
        pendingGeolocation = null;
        pendingGeolocationOrigin = null;
    }

    /**
     * The same trip out for the planned day: the marked date, its activity and
     * that activity's thresholds as plain numbers, so the background check can
     * apply them without a second copy of the rules living in Java.
     */
    private void syncPlan() {
        if (webView == null) return;
        reportNotificationState();
        webView.evaluateJavascript("localStorage.getItem('weatherdeck:events')", value -> {
            String stored = unwrap(value);
            SharedPreferences prefs = WidgetData.prefs(this);
            String previous = prefs.getString(PlanWatch.KEY_PLAN, "");
            if (stored == null || "[]".equals(stored.replace(" ", ""))) {
                if (!previous.isEmpty()) {
                    prefs.edit().remove(PlanWatch.KEY_PLAN).apply();
                    PlanWatch.reset(this, java.util.Collections.<String>emptySet());
                    PlanWatch.cancel(this);
                }
                return;
            }
            // Re-armed on every visit, because alarms do not survive a reboot.
            PlanWatch.schedule(this);
            if (stored.equals(previous)) return;
            prefs.edit().putString(PlanWatch.KEY_PLAN, stored).apply();
            // Baselines for sessions that are gone, or were edited, go with them.
            PlanWatch.reset(this, idsIn(stored));
            requestNotificationPermission();
        });
    }

    private static java.util.Set<String> idsIn(String sessions) {
        java.util.Set<String> ids = new java.util.HashSet<>();
        try {
            org.json.JSONArray parsed = new org.json.JSONArray(sessions);
            for (int i = 0; i < parsed.length(); i++) {
                org.json.JSONObject entry = parsed.optJSONObject(i);
                if (entry != null) ids.add(entry.optString("id", entry.optString("date", "")));
            }
        } catch (org.json.JSONException malformed) {
            // Keeping nothing is the safe direction here: a session quietly
            // starting its comparison over beats one inheriting a stale baseline.
        }
        return ids;
    }

    /**
     * Tells the page whether alerts can actually be posted. The page cannot ask
     * Android itself — no JavaScript interface is installed, deliberately — so
     * this is the one safe direction: Java writes, the page reads. Without it
     * the planner would promise notifications that were refused and never come.
     */
    private void reportNotificationState() {
        if (webView == null) return;
        boolean granted = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        String state = granted ? "granted" : "denied";
        WidgetData.prefs(this).edit().putString(PlanWatch.KEY_NOTIFY_STATE, state).apply();
        webView.evaluateJavascript(
                "try{localStorage.setItem('weatherdeck:notify','" + state + "')}catch(e){}", null);
    }

    /** evaluateJavascript hands back a JSON string literal, or the text "null". */
    private static String unwrap(String value) {
        if (value == null || "null".equals(value) || value.isEmpty()) return null;
        try {
            Object parsed = new org.json.JSONTokener(value).nextValue();
            String text = parsed == null ? null : parsed.toString();
            return text == null || text.isEmpty() || "null".equals(text) ? null : text;
        } catch (org.json.JSONException malformed) {
            return null;
        }
    }

    /** Only asked for once a day has been marked, because only then is there anything to say. */
    private void requestNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
    }

    /**
     * The widget runs outside the WebView and cannot read its localStorage, so
     * the chosen location is copied out to SharedPreferences. Reading the value
     * back is a plain evaluateJavascript call — no JavaScript interface is
     * installed, so the embedded map frame has nothing to reach for.
     */
    private void syncWidgetLocation() {
        if (webView == null) return;
        webView.evaluateJavascript("localStorage.getItem('weatherdeck:location')", value -> {
            if (value == null || "null".equals(value)) return;
            try {
                // evaluateJavascript hands back a JSON string literal.
                String json = new org.json.JSONTokener(value).nextValue().toString();
                org.json.JSONObject location = new org.json.JSONObject(json);
                double latitude = location.getDouble("latitude");
                double longitude = location.getDouble("longitude");
                SharedPreferences prefs = WidgetData.prefs(this);
                boolean moved = !Double.toString(latitude).equals(prefs.getString(WidgetData.KEY_LAT, null))
                        || !Double.toString(longitude).equals(prefs.getString(WidgetData.KEY_LON, null));
                prefs.edit()
                        .putString(WidgetData.KEY_LAT, Double.toString(latitude))
                        .putString(WidgetData.KEY_LON, Double.toString(longitude))
                        .putString(WidgetData.KEY_PLACE, location.optString("name", "Current location"))
                        .apply();
                if (moved) WidgetProvider.requestRefresh(this);
            } catch (org.json.JSONException malformed) {
                // Nothing usable stored yet; the widget keeps its last location.
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        syncWidgetLocation();
        syncPlan();
        // Closing the app is the cheapest moment to top the widget up, but only
        // if what it holds has actually gone stale.
        if (WidgetData.olderThan(this, WIDGET_REFRESH_AFTER_MS)) WidgetProvider.requestRefresh(this);
    }

    private void showFailure(String message) {
        statusView.setText("WeatherDeck could not start\n\n" + message);
        statusView.setVisibility(View.VISIBLE);
        if (webView != null) webView.setVisibility(View.INVISIBLE);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.setWebChromeClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
