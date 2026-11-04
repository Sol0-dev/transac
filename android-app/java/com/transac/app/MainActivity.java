package com.transac.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    private static final int STARTUP_REQUEST = 1001;

    private WebView webView;
    private Db db;
    private Bridge bridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#1266e3"));
        window.setNavigationBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }

        db = new Db(this);
        bridge = new Bridge(this, db);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        WebView.setWebContentsDebuggingEnabled(true);
        webView.addJavascriptInterface(bridge, "TransacNative");
        webView.setWebViewClient(new TransacWebViewClient(this));

        setContentView(webView);
        webView.loadUrl("file:///android_asset/www/index.html");

        requestStartupPermissions();
    }

    private static final class TransacWebViewClient extends WebViewClient {
        private final Activity activity;

        TransacWebViewClient(Activity activity) {
            this.activity = activity;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url == null) return false;
            if (url.startsWith("file://")) return false;
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
            }
            return true;
        }
    }

    /**
     * First launch asks for SMS access and, on Android versions that still use
     * shared storage permissions, storage access for CSV exports. Android 10+
     * saves exports through MediaStore, so no storage prompt is needed there.
     */
    public void requestStartupPermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        List<String> permissions = new ArrayList<>();
        addIfMissing(permissions, Manifest.permission.RECEIVE_SMS);
        addIfMissing(permissions, Manifest.permission.READ_SMS);
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            addIfMissing(permissions, Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            addIfMissing(permissions, Manifest.permission.READ_EXTERNAL_STORAGE);
        }
        if (!permissions.isEmpty()) {
            requestPermissions(permissions.toArray(new String[0]), STARTUP_REQUEST);
        }
    }

    private void addIfMissing(List<String> permissions, String permission) {
        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(permission);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == STARTUP_REQUEST && webView != null) {
            webView.postDelayed(() -> webView.evaluateJavascript(
                    "window.TransacPermissionResult && window.TransacPermissionResult()", null), 250);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (db != null) SyncClient.syncAsync(this);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("TransacNative");
            webView.destroy();
            webView = null;
        }
        if (db != null) {
            db.close();
            db = null;
        }
        super.onDestroy();
    }
}
