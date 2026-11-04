package com.transac.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Telephony;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.List;
import java.util.Locale;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

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
            out.put("hasLocalAccount", !isEmpty(db.getMeta("localHash")));
            out.put("localEmail", value(db.getMeta("localEmail")));
            out.put("localName", value(db.getMeta("localName")));
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

    /**
     * A local account lets the app work immediately, with no server. Its email is
     * reused when the same account is later created on the central server, so the
     * locally logged transactions sync to that account.
     */
    @JavascriptInterface
    public String localAuth(String mode, String name, String email, String password) {
        try {
            String cleanEmail = email == null ? "" : email.trim().toLowerCase(Locale.US);
            String cleanName = name == null ? "" : name.trim();
            String cleanPassword = password == null ? "" : password;
            if (!cleanEmail.matches("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")) {
                return SyncClient.error("Enter a valid email address.").toString();
            }
            if (cleanPassword.length() < 8) {
                return SyncClient.error("Password must be at least 8 characters.").toString();
            }

            String existingHash = db.getMeta("localHash");
            String existingEmail = db.getMeta("localEmail");
            if ("signup".equals(mode)) {
                if (cleanName.length() < 2) {
                    return SyncClient.error("Enter your full name.").toString();
                }
                if (!isEmpty(existingHash)) {
                    return SyncClient.error(
                            "This phone already has a local account. Sign in with " + existingEmail + ".").toString();
                }
                String salt = newSalt();
                db.setMeta("localSalt", salt);
                db.setMeta("localHash", hashPassword(cleanPassword, salt));
                db.setMeta("localName", cleanName);
                db.setMeta("localEmail", cleanEmail);
            } else {
                if (isEmpty(existingHash)) {
                    return SyncClient.error("No local account yet. Choose Sign up first.").toString();
                }
                if (existingEmail == null || !existingEmail.equalsIgnoreCase(cleanEmail)) {
                    return SyncClient.error("That is not the local account on this phone.").toString();
                }
                if (!verifyPassword(cleanPassword, db.getMeta("localSalt"), existingHash)) {
                    return SyncClient.error("Incorrect password.").toString();
                }
                cleanName = isEmpty(db.getMeta("localName")) ? "Phone user" : db.getMeta("localName");
            }

            JSONObject user = new JSONObject();
            user.put("id", "local");
            user.put("name", cleanName);
            user.put("email", cleanEmail);
            user.put("createdAt", Time.nowIso());

            db.setMeta("token", "local");
            db.setMeta("user", user.toString());
            db.setMeta("userEmail", cleanEmail);
            db.setMeta("serverUrl", "");
            db.setMeta("online", "0");
            db.removeMeta("authError");

            JSONObject out = SyncClient.ok();
            out.put("user", user);
            out.put("deviceName", deviceName());
            out.put("deviceId", deviceId());
            out.put("local", true);
            return out.toString();
        } catch (Exception error) {
            return SyncClient.error(error.getMessage()).toString();
        }
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
                boolean wasLocal = "local".equals(db.getMeta("token"));
                boolean changed = current != null && !current.isEmpty() && !current.equals(cleanUrl);
                db.setMeta("serverUrl", cleanUrl);
                if (changed || wasLocal) {
                    db.removeMeta("token");
                    db.removeMeta("user");
                    db.setMeta("online", "0");
                    out.put("signedOut", true);
                }
            } else if (!isEmpty(current)) {
                db.setMeta("serverUrl", "");
                db.removeMeta("token");
                db.removeMeta("user");
                db.setMeta("online", "0");
                out.put("signedOut", true);
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
    public String updateStatus(String id, String status, String claimedBy) {
        String cleanStatus = status == null ? "" : status.toUpperCase();
        String receiver = claimedBy == null ? "" : claimedBy.trim();
        if ("CLAIMED".equals(cleanStatus) && receiver.length() < 2) {
            return SyncClient.error("Enter the receiver's full name.").toString();
        }
        boolean updated = db.updateStatus(account(), id, cleanStatus, receiver);
        if (!updated) return SyncClient.error("Transaction not found.").toString();
        SyncClient.syncAsync(activity);
        return SyncClient.ok().toString();
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
    public String importInbox(String force) {
        if (activity.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            requestSmsPermission();
            return SyncClient.error("Allow the SMS permission, then tap Import again.").toString();
        }
        int scanned = 0;
        int imported = 0;
        Cursor cursor = null;
        long since = 0;
        if (!"1".equals(force)) {
            String saved = db.getMeta("lastInboxScan");
            if (saved != null && !saved.isEmpty()) {
                try {
                    since = Long.parseLong(saved);
                } catch (NumberFormatException ignored) {
                }
            }
        }
        long newest = since;
        try {
            String selection = since > 0 ? Telephony.Sms.DATE + " >= ?" : null;
            String[] selectionArgs = since > 0 ? new String[]{String.valueOf(since)} : null;
            cursor = activity.getContentResolver().query(
                    Telephony.Sms.Inbox.CONTENT_URI,
                    new String[]{Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE},
                    selection, selectionArgs, Telephony.Sms.DATE + " DESC");
            if (cursor != null) {
                while (cursor.moveToNext() && scanned < 500) {
                    scanned++;
                    String sender = cursor.getString(0);
                    String body = cursor.getString(1);
                    long timestamp = cursor.getLong(2);
                    if (timestamp > newest) newest = timestamp;
                    if (!SmsParser.isTransactionMessage(sender, body)) continue;
                    SmsParser.Parsed parsed = SmsParser.parse(sender, body, Time.toIso(timestamp));
                    if (!parsed.ok) continue;
                    parsed.tx.source = "inbox";
                    Db.InsertResult result = db.insert(parsed.tx, account(), deviceId(), deviceName());
                    if (result.error == null && !result.duplicate) imported++;
                }
            }
            db.setMeta("lastInboxScan", String.valueOf(newest > 0 ? newest : System.currentTimeMillis()));
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
            if (activity instanceof MainActivity) ((MainActivity) activity).requestStartupPermissions();
        });
        return SyncClient.ok().toString();
    }

    @JavascriptInterface
    public String saveCsv(String filename, String content) {
        String clean = filename == null || filename.trim().isEmpty()
                ? "transac-logs.csv"
                : filename.trim().replaceAll("[^A-Za-z0-9._-]", "_");
        byte[] bytes = (content == null ? "" : content).getBytes(StandardCharsets.UTF_8);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, clean);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "text/csv");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return SyncClient.error("Could not create the CSV file.").toString();
                try (OutputStream output = activity.getContentResolver().openOutputStream(uri)) {
                    if (output == null) return SyncClient.error("Could not open the CSV file.").toString();
                    output.write(bytes);
                }
                values.clear();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                activity.getContentResolver().update(uri, values, null, null);
                JSONObject out = SyncClient.ok();
                out.put("path", Environment.DIRECTORY_DOWNLOADS + "/" + clean);
                return out.toString();
            }

            if (activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                requestSmsPermission();
                return SyncClient.error("Allow storage permission, then tap Export CSV again.").toString();
            }
            File directory = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!directory.exists() && !directory.mkdirs()) {
                return SyncClient.error("Could not create the Downloads folder.").toString();
            }
            File file = new File(directory, clean);
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(bytes);
            }
            JSONObject out = SyncClient.ok();
            out.put("path", file.getAbsolutePath());
            return out.toString();
        } catch (Exception error) {
            return SyncClient.error(error.getMessage()).toString();
        }
    }

    @JavascriptInterface
    public String copyText(String text) {
        try {
            ClipboardManager manager = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (manager == null) return SyncClient.error("Clipboard is not available.").toString();
            manager.setPrimaryClip(ClipData.newPlainText("TRANSAC CSV", text == null ? "" : text));
            return SyncClient.ok().toString();
        } catch (Exception error) {
            return SyncClient.error(error.getMessage()).toString();
        }
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
        json.put("claimedBy", value(tx.claimedBy));
        json.put("claimedAt", value(tx.claimedAt));
        json.put("statusDirty", tx.statusDirty);
        return json;
    }

    private static Object value(String value) {
        return value == null ? JSONObject.NULL : value;
    }

    private static boolean isEmpty(String value) {
        return value == null || value.isEmpty();
    }

    private static String newSalt() {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        return Base64.encodeToString(salt, Base64.NO_WRAP);
    }

    private static String hashPassword(String password, String saltBase64) throws Exception {
        byte[] salt = Base64.decode(saltBase64, Base64.NO_WRAP);
        PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, 120000, 256);
        try {
            SecretKeyFactory factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1");
            return Base64.encodeToString(factory.generateSecret(spec).getEncoded(), Base64.NO_WRAP);
        } finally {
            spec.clearPassword();
        }
    }

    private static boolean verifyPassword(String password, String saltBase64, String expectedBase64) {
        if (isEmpty(saltBase64) || isEmpty(expectedBase64)) return false;
        try {
            byte[] actual = Base64.decode(hashPassword(password, saltBase64), Base64.NO_WRAP);
            byte[] expected = Base64.decode(expectedBase64, Base64.NO_WRAP);
            return MessageDigest.isEqual(actual, expected);
        } catch (Exception error) {
            return false;
        }
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
