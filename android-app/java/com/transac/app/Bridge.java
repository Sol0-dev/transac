package com.transac.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

/** The only surface exposed to the bundled WebView. Every method returns JSON. */
public class Bridge {

    private final Activity activity;
    private final Db db;

    public Bridge(Activity activity, Db db) {
        this.activity = activity;
        this.db = db;
    }

    private String account() {
        return db.account();
    }

    private String deviceId() {
        return db.ensureDeviceId();
    }

    private String deviceName() {
        return db.deviceName();
    }

    @JavascriptInterface
    public String getStatus() {
        JSONObject out = new JSONObject();
        try {
            String token = db.getMeta("token");
            String userJson = db.getMeta("user");
            boolean signedIn = token != null && !token.isEmpty() && userJson != null && !userJson.isEmpty();
            JSONObject user = null;
            if (userJson != null && !userJson.isEmpty()) {
                try {
                    user = new JSONObject(userJson);
                } catch (Exception ignored) {
                }
            }
            out.put("signedIn", signedIn);
            out.put("user", user == null ? JSONObject.NULL : user);
            out.put("serverUrl", value(db.getMeta("serverUrl")));
            out.put("deviceId", deviceId());
            out.put("deviceName", deviceName());
            out.put("online", "1".equals(db.getMeta("online")));
            out.put("pending", db.pending(account()));
            out.put("lastSync", value(db.getMeta("lastSync")));
            out.put("authError", value(db.getMeta("authError")));
            out.put("platform", "android");
        } catch (Exception error) {
            return err(error.getMessage()).toString();
        }
        return out.toString();
    }

    @JavascriptInterface
    public String login(String serverUrl, String email, String password) {
        JSONObject result = SyncClient.login(db, serverUrl, email, password);
        if (result.optBoolean("ok")) SyncClient.syncAsync(activity);
        return result.toString();
    }

    @JavascriptInterface
    public String signup(String serverUrl, String name, String email, String password) {
        JSONObject result = SyncClient.signup(db, serverUrl, name, email, password);
        if (result.optBoolean("ok")) SyncClient.syncAsync(activity);
        return result.toString();
    }

    @JavascriptInterface
    public String logout() {
        db.removeMeta("token");
        db.removeMeta("user");
        db.removeMeta("userEmail");
        db.removeMeta("authError");
        db.setMeta("online", "0");
        return SyncClient.ok().toString();
    }

    @JavascriptInterface
    public String setSettings(String name, String serverUrl) {
        JSONObject out = SyncClient.ok();
        try {
            String current = db.getMeta("serverUrl");
            String cleanName = name == null ? "" : name.trim();
            String cleanUrl = serverUrl == null ? "" : serverUrl.trim();
            while (cleanUrl.endsWith("/")) cleanUrl = cleanUrl.substring(0, cleanUrl.length() - 1);

            if (!cleanUrl.isEmpty()) {
                if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) {
                    return SyncClient.error("Server URL must start with http:// or https://.").toString();
                }
                boolean changed = current != null && !current.isEmpty() && !current.equals(cleanUrl);
                db.setMeta("serverUrl", cleanUrl);
                if (changed) {
                    db.removeMeta("token");
                    db.removeMeta("user");
                    db.removeMeta("userEmail");
                    db.setMeta("online", "0");
                    out.put("signedOut", true);
                }
            }
            if (!cleanName.isEmpty()) db.setMeta("deviceName", cleanName);
            out.put("deviceName", deviceName());
            out.put("serverUrl", value(db.getMeta("serverUrl")));
        } catch (Exception error) {
            return err(error.getMessage()).toString();
        }
        return out.toString();
    }

    @JavascriptInterface
    public String list(String limit) {
        JSONObject out = new JSONObject();
        try {
            int size = parseInt(limit, 300);
            List<Tx> rows = db.list(account(), size);
            JSONArray transactions = new JSONArray();
            for (Tx tx : rows) transactions.put(txJson(tx));
            out.put("ok", true);
            out.put("transactions", transactions);
            out.put("pending", db.pending(account()));
        } catch (Exception error) {
            return err(error.getMessage()).toString();
        }
        return out.toString();
    }

    @JavascriptInterface
    public String parse(String sender, String body) {
        SmsParser.Parsed parsed = SmsParser.parse(sender, body, Time.nowIso());
        JSONObject out = new JSONObject();
        try {
            out.put("ok", parsed.ok);
            if (parsed.ok) out.put("transaction", txJson(parsed.tx));
            else out.put("reason", parsed.reason);
        } catch (Exception error) {
            return err(error.getMessage()).toString();
        }
        return out.toString();
    }

    @JavascriptInterface
    public String ingest(String sender, String body, String receivedAt, String source) {
        JSONObject out = new JSONObject();
        try {
            SmsParser.Parsed parsed = SmsParser.parse(sender, body, Time.normalize(receivedAt));
            if (!parsed.ok) {
                out.put("ok", true);
                out.put("rejected", true);
                out.put("reason", parsed.reason);
                return out.toString();
            }
            parsed.tx.source = source == null || source.isEmpty() ? "sms" : source;
            Db.InsertResult result = db.insert(parsed.tx, account(), deviceId(), deviceName());
            if (result.error != null && !result.duplicate) return err(result.error).toString();
            out.put("ok", true);
            out.put("rejected", false);
            out.put("inserted", result.duplicate ? 0 : 1);
            out.put("duplicate", result.duplicate);
            if (result.tx != null) out.put("transaction", txJson(result.tx));
            if (!result.duplicate) SyncClient.syncAsync(activity);
        } catch (Exception error) {
            return err(error.getMessage()).toString();
        }
        return out.toString();
    }

    @JavascriptInterface
    public String addManual(String json) {
        try {
            JSONObject input = new JSONObject(json == null ? "{}" : json);
            double amount = input.optDouble("amount", 0);
            String reference = input.optString("reference", "").trim().toUpperCase();
            if (amount <= 0) return SyncClient.error("Enter a valid amount.").toString();
            if (reference.length() < 4) return SyncClient.error("Enter the reference number.").toString();

            String provider = input.optString("provider", "unknown");
            if (!"gcash".equals(provider) && !"maya".equals(provider)) provider = "unknown";
            String direction = "debit".equals(input.optString("direction", "credit")) ? "debit" : "credit";

            Tx tx = new Tx();
            tx.provider = provider;
            tx.providerLabel = SmsParser.providerLabel(provider);
            tx.reference = reference;
            tx.amount = amount;
            tx.direction = direction;
            tx.status = "credit".equals(direction) ? "UNCLAIMED" : "SENT";
            tx.counterparty = input.optString("counterparty", "");
            tx.sender = "Manual entry";
            tx.body = input.optString("body", "Manually logged transaction. Ref " + reference + ".");
            tx.receivedAt = Time.normalize(input.optString("receivedAt", ""));
            tx.source = "manual";

            Db.InsertResult result = db.insert(tx, account(), deviceId(), deviceName());
            if (result.error != null && !result.duplicate) return SyncClient.error(result.error).toString();
            JSONObject out = SyncClient.ok();
            out.put("duplicate", result.duplicate);
            out.put("transaction", txJson(result.tx));
            if (!result.duplicate) SyncClient.syncAsync(activity);
            return out.toString();
        } catch (Exception error) {
            return SyncClient.error(error.getMessage()).toString();
        }
    }

    @JavascriptInterface
    public String updateStatus(String id, String status) {
        boolean updated = db.updateStatus(account(), id, status == null ? "" : status.toUpperCase());
        return updated ? SyncClient.ok().toString() : SyncClient.error("Transaction not found.").toString();
    }

    @JavascriptInterface
    public String remove(String id) {
        boolean removed = db.delete(account(), id);
        return removed ? SyncClient.ok().toString() : SyncClient.error("Transaction not found.").toString();
    }

    @JavascriptInterface
    public String sync() {
        SyncClient.syncAsync(activity);
        return SyncClient.ok().toString();
    }

    @JavascriptInterface
    public String importInbox() {
        if (activity.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            requestSmsPermission();
            return SyncClient.error("Allow the SMS permission, then tap Import again.").toString();
        }
        int scanned = 0;
        int imported = 0;
        Cursor cursor = null;
        try {
            cursor = activity.getContentResolver().query(
                    Telephony.Sms.Inbox.CONTENT_URI,
                    new String[]{Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE},
                    null, null, Telephony.Sms.DATE + " DESC");
            if (cursor != null) {
                while (cursor.moveToNext() && scanned < 500) {
                    scanned++;
                    String sender = cursor.getString(0);
                    String body = cursor.getString(1);
                    long timestamp = cursor.getLong(2);
                    if (!SmsParser.isTransactionMessage(sender, body)) continue;
                    SmsParser.Parsed parsed = SmsParser.parse(sender, body, Time.toIso(timestamp));
                    if (!parsed.ok) continue;
                    parsed.tx.source = "inbox";
                    Db.InsertResult result = db.insert(parsed.tx, account(), deviceId(), deviceName());
                    if (result.error == null && !result.duplicate) imported++;
                }
            }
            if (imported > 0) SyncClient.syncAsync(activity);
            JSONObject out = SyncClient.ok();
            out.put("imported", imported);
            out.put("scanned", scanned);
            out.put("pending", db.pending(account()));
            return out.toString();
        } catch (SecurityException error) {
            requestSmsPermission();
            return SyncClient.error("SMS permission is required to import messages.").toString();
        } catch (Exception error) {
            return SyncClient.error(error.getMessage()).toString();
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    @JavascriptInterface
    public String requestSmsPermission() {
        activity.runOnUiThread(() -> {
            if (activity instanceof MainActivity) ((MainActivity) activity).requestSmsPermissions();
        });
        return SyncClient.ok().toString();
    }

    @JavascriptInterface
    public String openUrl(String url) {
        if (url == null) return SyncClient.error("No URL.").toString();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            return SyncClient.error("Only web links are allowed.").toString();
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            return SyncClient.ok().toString();
        } catch (Exception error) {
            return SyncClient.error("No browser available.").toString();
        }
    }

    private JSONObject txJson(Tx tx) throws Exception {
        JSONObject json = new JSONObject();
        json.put("id", value(tx.id));
        json.put("provider", value(tx.provider));
        json.put("providerLabel", value(tx.providerLabel));
        json.put("reference", value(tx.reference));
        json.put("amount", tx.amount);
        json.put("currency", value(tx.currency));
        json.put("direction", value(tx.direction));
        json.put("status", value(tx.status));
        json.put("counterparty", value(tx.counterparty));
        json.put("sender", value(tx.sender));
        json.put("body", value(tx.body));
        json.put("receivedAt", value(tx.receivedAt));
        json.put("createdAt", value(tx.createdAt));
        json.put("deviceId", value(tx.deviceId));
        json.put("deviceName", value(tx.deviceName));
        json.put("source", value(tx.source));
        json.put("synced", tx.synced);
        return json;
    }

    private static Object value(String value) {
        return value == null ? JSONObject.NULL : value;
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(value);
        } catch (Exception error) {
            return fallback;
        }
    }

    private static JSONObject err(String message) {
        return SyncClient.error(message == null ? "Something went wrong." : message);
    }
}
