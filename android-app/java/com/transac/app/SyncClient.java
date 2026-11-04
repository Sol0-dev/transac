package com.transac.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Talks to the centralized TRANSAC server. All network calls run off the UI thread. */
public final class SyncClient {

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final int CONNECT_TIMEOUT = 8000;
    private static final int READ_TIMEOUT = 15000;

    private SyncClient() {}

    private static final class Response {
        int code;
        String body;

        boolean ok() {
            return code >= 200 && code < 300;
        }
    }

    public static void syncAsync(Context context) {
        final Context app = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            Db db = new Db(app);
            try {
                sync(db);
            } finally {
                db.close();
            }
        });
    }

    static JSONObject login(Db db, String serverUrl, String email, String password) {
        String base = normalize(serverUrl);
        if (base == null) return error("Enter a valid server URL (http:// or https://).");
        try {
            JSONObject payload = new JSONObject();
            payload.put("email", email);
            payload.put("password", password);
            Response response = post(base + "/api/auth/login", null, payload);
            JSONObject body = body(response);
            if (!response.ok()) return error(body.optString("error", "Could not sign in."));

            JSONObject user = body.optJSONObject("user");
            String token = body.optString("token", "");
            if (user == null || token.isEmpty()) return error("The server returned an invalid session.");

            db.setMeta("token", token);
            db.setMeta("user", user.toString());
            db.setMeta("userEmail", user.optString("email", email).toLowerCase());
            db.setMeta("serverUrl", base);
            db.setMeta("online", "1");
            db.setMeta("lastSync", Time.nowIso());
            db.removeMeta("authError");
            db.ensureDeviceId();

            JSONObject out = ok();
            out.put("user", user);
            out.put("deviceName", db.deviceName());
            out.put("deviceId", db.ensureDeviceId());
            return out;
        } catch (Exception exception) {
            return error(exception.getMessage() == null ? "Could not reach the server." : exception.getMessage());
        }
    }

    static JSONObject signup(Db db, String serverUrl, String name, String email, String password) {
        String base = normalize(serverUrl);
        if (base == null) return error("Enter a valid server URL (http:// or https://).");
        try {
            JSONObject payload = new JSONObject();
            payload.put("name", name);
            payload.put("email", email);
            payload.put("password", password);
            Response response = post(base + "/api/auth/register", null, payload);
            JSONObject body = body(response);
            if (!response.ok()) return error(body.optString("error", "Could not create the account."));

            JSONObject user = body.optJSONObject("user");
            String token = body.optString("token", "");
            if (user == null || token.isEmpty()) return error("The server returned an invalid session.");

            db.setMeta("token", token);
            db.setMeta("user", user.toString());
            db.setMeta("userEmail", user.optString("email", email).toLowerCase());
            db.setMeta("serverUrl", base);
            db.setMeta("online", "1");
            db.setMeta("lastSync", Time.nowIso());
            db.removeMeta("authError");
            db.ensureDeviceId();

            JSONObject out = ok();
            out.put("user", user);
            out.put("deviceName", db.deviceName());
            out.put("deviceId", db.ensureDeviceId());
            return out;
        } catch (Exception exception) {
            return error(exception.getMessage() == null ? "Could not reach the server." : exception.getMessage());
        }
    }

    static void sync(Db db) {
        String serverUrl = normalize(db.getMeta("serverUrl"));
        String token = db.getMeta("token");
        String account = db.account();
        if (serverUrl == null || token == null || token.isEmpty() || account.isEmpty()) {
            db.setMeta("online", "0");
            return;
        }
        String deviceId = db.ensureDeviceId();
        String deviceName = db.deviceName();

        try {
            // Register / refresh this phone in the control center.
            JSONObject device = new JSONObject();
            device.put("device", new JSONObject()
                    .put("id", deviceId)
                    .put("name", deviceName)
                    .put("platform", "android"));
            Response registration = post(serverUrl + "/api/devices/register", token, device);
            if (registration.code == 401) {
                sessionExpired(db);
                return;
            }

            List<Tx> pending = db.unsynced(account, 50);
            if (!pending.isEmpty()) {
                JSONArray messages = new JSONArray();
                for (Tx tx : pending) {
                    messages.put(new JSONObject()
                            .put("sender", tx.sender == null ? "" : tx.sender)
                            .put("body", tx.body == null ? "" : tx.body)
                            .put("receivedAt", tx.receivedAt)
                            .put("source", tx.source == null ? "sms" : tx.source));
                }
                JSONObject payload = new JSONObject();
                payload.put("device", new JSONObject()
                        .put("id", deviceId)
                        .put("name", deviceName)
                        .put("platform", "android"));
                payload.put("messages", messages);

                Response response = post(serverUrl + "/api/ingest", token, payload);
                if (response.code == 401) {
                    sessionExpired(db);
                    return;
                }
                if (!response.ok()) {
                    db.setMeta("online", "0");
                    return;
                }
                List<String> ids = new ArrayList<>();
                for (Tx tx : pending) ids.add(tx.id);
                db.markSynced(ids);
            }

            db.setMeta("online", "1");
            db.setMeta("lastSync", Time.nowIso());
            db.removeMeta("authError");
        } catch (Exception exception) {
            db.setMeta("online", "0");
        }
    }

    private static void sessionExpired(Db db) {
        db.setMeta("online", "0");
        db.setMeta("authError", "Your session expired. Sign in again.");
        db.removeMeta("token");
        db.removeMeta("user");
    }

    private static JSONObject body(Response response) {
        try {
            return response.body == null || response.body.isEmpty() ? new JSONObject() : new JSONObject(response.body);
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    private static String normalize(String serverUrl) {
        if (serverUrl == null) return null;
        String base = serverUrl.trim();
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        if (!base.startsWith("http://") && !base.startsWith("https://")) return null;
        return base;
    }

    private static Response post(String url, String token, JSONObject payload) {
        Response response = new Response();
        HttpURLConnection connection = null;
        try {
            byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT);
            connection.setReadTimeout(READ_TIMEOUT);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(bytes.length);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            if (token != null && !token.isEmpty()) {
                connection.setRequestProperty("Authorization", "Bearer " + token);
            }
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
            response.code = connection.getResponseCode();
            InputStream stream = response.code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) {
                response.body = "";
            } else {
                StringBuilder text = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) text.append(line);
                }
                response.body = text.toString();
            }
        } catch (Exception error) {
            response.code = 0;
            response.body = "{\"error\":\"" + String.valueOf(error.getMessage()).replace("\"", "'") + "\"}";
        } finally {
            if (connection != null) connection.disconnect();
        }
        return response;
    }

    static JSONObject ok() {
        JSONObject result = new JSONObject();
        try {
            result.put("ok", true);
        } catch (Exception ignored) {
        }
        return result;
    }

    static JSONObject error(String message) {
        JSONObject result = new JSONObject();
        try {
            result.put("ok", false);
            result.put("error", message);
        } catch (Exception ignored) {
        }
        return result;
    }
}
