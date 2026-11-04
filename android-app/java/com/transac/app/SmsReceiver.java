package com.transac.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Listens for incoming SMS, parses GCash/Maya notifications and stores them in
 * the on-device ledger. SyncClient uploads them to the central platform.
 */
public class SmsReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;

        SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (messages == null || messages.length == 0) return;

        Context app = context.getApplicationContext();
        Db db = new Db(app);
        try {
            String account = db.account();
            if (account == null || account.isEmpty()) return; // not signed in yet

            String deviceId = db.ensureDeviceId();
            String deviceName = db.deviceName();
            boolean inserted = false;

            Map<String, Group> groups = new LinkedHashMap<>();
            for (SmsMessage message : messages) {
                if (message == null) continue;
                String sender = message.getOriginatingAddress();
                long timestamp = message.getTimestampMillis();
                String key = String.valueOf(sender) + "#" + timestamp;
                Group group = groups.get(key);
                if (group == null) {
                    group = new Group(sender, timestamp);
                    groups.put(key, group);
                }
                group.body.append(message.getMessageBody() == null ? "" : message.getMessageBody());
            }

            for (Group group : groups.values()) {
                String body = group.body.toString();
                if (!SmsParser.isTransactionMessage(group.sender, body)) continue;
                SmsParser.Parsed parsed = SmsParser.parse(group.sender, body, Time.toIso(group.timestamp));
                if (!parsed.ok) continue;
                parsed.tx.source = "sms";
                Db.InsertResult result = db.insert(parsed.tx, account, deviceId, deviceName);
                if (result.error == null && !result.duplicate) inserted = true;
            }

            if (inserted) SyncClient.syncAsync(app);
        } catch (Exception ignored) {
            // Never crash the SMS receiver; the message stays in the inbox and can
            // be imported later from the app.
        } finally {
            db.close();
        }
    }

    private static final class Group {
        final String sender;
        final long timestamp;
        final StringBuilder body = new StringBuilder();

        Group(String sender, long timestamp) {
            this.sender = sender;
            this.timestamp = timestamp;
        }
    }
}
