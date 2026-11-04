package com.transac.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/** On-device ledger. Rows are scoped to the signed-in account and queued for sync. */
public class Db extends SQLiteOpenHelper {

    private static final String NAME = "transac.db";
    private static final int VERSION = 1;

    public static final class InsertResult {
        public boolean duplicate;
        public Tx tx;
        public String error;
    }

    public Db(Context context) {
        super(context.getApplicationContext(), NAME, null, VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
                "CREATE TABLE transactions ("
                        + "id TEXT PRIMARY KEY,"
                        + "account TEXT NOT NULL,"
                        + "provider TEXT NOT NULL,"
                        + "provider_label TEXT,"
                        + "reference TEXT NOT NULL,"
                        + "amount REAL NOT NULL,"
                        + "currency TEXT DEFAULT 'PHP',"
                        + "direction TEXT NOT NULL,"
                        + "status TEXT NOT NULL,"
                        + "counterparty TEXT,"
                        + "sender TEXT,"
                        + "body TEXT,"
                        + "received_at TEXT NOT NULL,"
                        + "created_at TEXT NOT NULL,"
                        + "device_id TEXT,"
                        + "device_name TEXT,"
                        + "source TEXT,"
                        + "synced INTEGER DEFAULT 0"
                        + ")");
        db.execSQL("CREATE UNIQUE INDEX idx_transac_dedupe ON transactions(account, provider, reference)");
        db.execSQL("CREATE INDEX idx_transac_received ON transactions(received_at DESC)");
        db.execSQL("CREATE INDEX idx_transac_pending ON transactions(account, synced)");
        db.execSQL("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // First release: no migrations yet.
    }

    /* ----------------------------- meta ------------------------------ */

    public String getMeta(String key) {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT value FROM meta WHERE key = ?", new String[]{key})) {
            if (cursor.moveToFirst()) return cursor.getString(0);
        }
        return null;
    }

    public void setMeta(String key, String value) {
        ContentValues values = new ContentValues();
        values.put("key", key);
        values.put("value", value);
        getWritableDatabase().insertWithOnConflict("meta", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public void removeMeta(String key) {
        getWritableDatabase().delete("meta", "key = ?", new String[]{key});
    }

    /* ------------------------- transactions -------------------------- */

    public InsertResult insert(Tx tx, String account, String deviceId, String deviceName) {
        InsertResult result = new InsertResult();
        if (account == null || account.isEmpty()) {
            result.error = "Not signed in.";
            return result;
        }

        String existingId = findId(account, tx.provider, tx.reference);
        if (existingId != null) {
            result.duplicate = true;
            result.tx = get(account, existingId);
            return result;
        }

        tx.id = UUID.randomUUID().toString();
        tx.createdAt = Time.nowIso();
        tx.deviceId = deviceId;
        tx.deviceName = deviceName;
        tx.synced = false;
        if (tx.receivedAt == null || tx.receivedAt.isEmpty()) tx.receivedAt = Time.nowIso();
        if (tx.currency == null) tx.currency = "PHP";
        if (tx.status == null) tx.status = "credit".equals(tx.direction) ? "UNCLAIMED" : "SENT";
        if (tx.source == null) tx.source = "sms";

        ContentValues values = valuesFor(tx, account);
        try {
            getWritableDatabase().insertOrThrow("transactions", null, values);
            result.tx = tx;
        } catch (Exception error) {
            // Unique index race: treat the existing row as the winner.
            String id = findId(account, tx.provider, tx.reference);
            if (id != null) {
                result.duplicate = true;
                result.tx = get(account, id);
            } else {
                result.error = error.getMessage();
            }
        }
        return result;
    }

    private ContentValues valuesFor(Tx tx, String account) {
        ContentValues values = new ContentValues();
        values.put("id", tx.id);
        values.put("account", account);
        values.put("provider", tx.provider);
        values.put("provider_label", tx.providerLabel);
        values.put("reference", tx.reference);
        values.put("amount", tx.amount);
        values.put("currency", tx.currency);
        values.put("direction", tx.direction);
        values.put("status", tx.status);
        values.put("counterparty", tx.counterparty);
        values.put("sender", tx.sender);
        values.put("body", tx.body);
        values.put("received_at", tx.receivedAt);
        values.put("created_at", tx.createdAt);
        values.put("device_id", tx.deviceId);
        values.put("device_name", tx.deviceName);
        values.put("source", tx.source);
        values.put("synced", tx.synced ? 1 : 0);
        return values;
    }

    private String findId(String account, String provider, String reference) {
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT id FROM transactions WHERE account = ? AND provider = ? AND reference = ? LIMIT 1",
                new String[]{account, provider, reference})) {
            if (cursor.moveToFirst()) return cursor.getString(0);
        }
        return null;
    }

    public List<Tx> list(String account, int limit) {
        List<Tx> rows = new ArrayList<>();
        if (account == null || account.isEmpty()) return rows;
        String size = String.valueOf(Math.max(1, Math.min(1000, limit)));
        try (Cursor cursor = getReadableDatabase().query(
                "transactions", null, "account = ?", new String[]{account}, null, null,
                "received_at DESC", size)) {
            while (cursor.moveToNext()) rows.add(read(cursor));
        }
        return rows;
    }

    public List<Tx> unsynced(String account, int limit) {
        List<Tx> rows = new ArrayList<>();
        if (account == null || account.isEmpty()) return rows;
        String size = String.valueOf(Math.max(1, Math.min(100, limit)));
        try (Cursor cursor = getReadableDatabase().query(
                "transactions", null, "account = ? AND synced = 0", new String[]{account}, null, null,
                "received_at ASC", size)) {
            while (cursor.moveToNext()) rows.add(read(cursor));
        }
        return rows;
    }

    public int pending(String account) {
        if (account == null || account.isEmpty()) return 0;
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT COUNT(*) FROM transactions WHERE account = ? AND synced = 0", new String[]{account})) {
            if (cursor.moveToFirst()) return cursor.getInt(0);
        }
        return 0;
    }

    public void markSynced(List<String> ids) {
        if (ids == null || ids.isEmpty()) return;
        StringBuilder placeholders = new StringBuilder();
        String[] args = new String[ids.size()];
        for (int i = 0; i < ids.size(); i++) {
            if (i > 0) placeholders.append(',');
            placeholders.append('?');
            args[i] = ids.get(i);
        }
        ContentValues values = new ContentValues();
        values.put("synced", 1);
        getWritableDatabase().update("transactions", values, "id IN (" + placeholders + ")", args);
    }

    public Tx get(String account, String id) {
        try (Cursor cursor = getReadableDatabase().query(
                "transactions", null, "account = ? AND id = ?", new String[]{account, id}, null, null, null, "1")) {
            if (cursor.moveToFirst()) return read(cursor);
        }
        return null;
    }

    public boolean updateStatus(String account, String id, String status) {
        if (!allowedStatus(status)) return false;
        ContentValues values = new ContentValues();
        values.put("status", status);
        return getWritableDatabase().update("transactions", values, "account = ? AND id = ?",
                new String[]{account, id}) > 0;
    }

    public boolean delete(String account, String id) {
        return getWritableDatabase().delete("transactions", "account = ? AND id = ?",
                new String[]{account, id}) > 0;
    }

    private boolean allowedStatus(String status) {
        return "UNCLAIMED".equals(status) || "CLAIMED".equals(status) || "SENT".equals(status);
    }

    private Tx read(Cursor cursor) {
        Tx tx = new Tx();
        tx.id = string(cursor, "id");
        tx.provider = string(cursor, "provider");
        tx.providerLabel = string(cursor, "provider_label");
        tx.reference = string(cursor, "reference");
        tx.amount = cursor.getDouble(cursor.getColumnIndexOrThrow("amount"));
        tx.currency = string(cursor, "currency");
        tx.direction = string(cursor, "direction");
        tx.status = string(cursor, "status");
        tx.counterparty = string(cursor, "counterparty");
        tx.sender = string(cursor, "sender");
        tx.body = string(cursor, "body");
        tx.receivedAt = string(cursor, "received_at");
        tx.createdAt = string(cursor, "created_at");
        tx.deviceId = string(cursor, "device_id");
        tx.deviceName = string(cursor, "device_name");
        tx.source = string(cursor, "source");
        tx.synced = cursor.getInt(cursor.getColumnIndexOrThrow("synced")) == 1;
        return tx;
    }

    private String string(Cursor cursor, String column) {
        int index = cursor.getColumnIndexOrThrow(column);
        return cursor.isNull(index) ? null : cursor.getString(index);
    }

    public String ensureDeviceId() {
        String id = getMeta("deviceId");
        if (id == null || id.isEmpty()) {
            id = "dev_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            setMeta("deviceId", id);
        }
        return id;
    }

    public String deviceName() {
        String name = getMeta("deviceName");
        if (name == null || name.isEmpty()) {
            name = (android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL).trim();
            if (name.isEmpty()) name = "Android phone";
            setMeta("deviceName", name);
        }
        return name;
    }

    public String titleCaseProvider(String provider) {
        return providerLabel(provider);
    }

    private String providerLabel(String provider) {
        if ("gcash".equals(provider)) return "GCash";
        if ("maya".equals(provider)) return "Maya";
        return "Other";
    }

    public String account() {
        String email = getMeta("userEmail");
        return email == null ? "" : email.toLowerCase(Locale.US);
    }
}
