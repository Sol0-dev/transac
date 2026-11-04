package com.transac.app;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Native port of lib/parser.js. Kept in sync with the web parser so a message
 * produces the same reference, amount and status on the phone and on the server.
 */
public final class SmsParser {

    public static final Pattern AMOUNT = Pattern.compile(
            "(?:php|ph\u20b1|\u20b1|\\bp\\s?)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern AMOUNT_LABEL = Pattern.compile(
            "amount\\s*[:\\-]?\\s*(?:php|\\u20b1|\\bp\\b)?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern REF = Pattern.compile(
            "\\bref(?:erence)?(?:\\s*(?:no\\.?|number|num\\.?|#|id))?\\s*[:#\\-]?\\s*([A-Z0-9][A-Z0-9\\-]{5,})",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern LONG_NUMBER = Pattern.compile("\\b(\\d{10,20})\\b");
    private static final Pattern CREDIT = Pattern.compile(
            "(?:received|receive|credited|credit\\b|deposited|deposit\\b|cash[\\s-]?in|added to your|you (?:have )?got|incoming|payment received|money received)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern DEBIT = Pattern.compile(
            "(?:sent\\b|send\\b|paid\\b|pay\\b|debited|debit\\b|cash[\\s-]?out|withdrew|withdraw|transferred to|you paid|purchase|bills? payment)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern FROM = Pattern.compile(
            "\\bfrom\\s+([A-Za-z0-9 ._'@-]{2,60}?)(?:\\s*\\(|\\s+Ref|\\s*\\.\\s|\\s*$)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern TO = Pattern.compile(
            "\\bto\\s+([A-Za-z0-9 ._'@-]{2,60}?)(?:\\s*\\(|\\s+Ref|\\s*\\.\\s|\\s*$)",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern FROM_NUMBER = Pattern.compile(
            "\\bfrom\\s+([0-9+\\- ]{7,20})",
            Pattern.CASE_INSENSITIVE);

    private SmsParser() {}

    public static final class Parsed {
        public boolean ok;
        public String reason;
        public Tx tx;
    }

    public static String providerLabel(String provider) {
        if ("gcash".equals(provider)) return "GCash";
        if ("maya".equals(provider)) return "Maya";
        return "Other";
    }

    public static String detectProvider(String sender, String body) {
        String from = sender == null ? "" : sender.toLowerCase(Locale.US);
        String text = body == null ? "" : body.toLowerCase(Locale.US);
        if (from.contains("gcash") || from.contains("g-cash") || from.contains("mynt") || from.contains("2882")) {
            return "gcash";
        }
        if (from.contains("paymaya") || from.matches(".*\\bmaya\\b.*")) return "maya";
        if (text.contains("gcash") || text.contains("g-cash") || text.contains("mynt")) return "gcash";
        if (text.contains("paymaya") || text.contains("maya wallet") || text.matches(".*\\bmaya\\b.*")) return "maya";
        return "unknown";
    }

    public static Double parseAmount(String body) {
        String text = body == null ? "" : body;
        Matcher direct = AMOUNT.matcher(text);
        if (direct.find()) return toAmount(direct.group(1));
        Matcher labelled = AMOUNT_LABEL.matcher(text);
        if (labelled.find()) return toAmount(labelled.group(1));
        return null;
    }

    private static Double toAmount(String raw) {
        try {
            return Math.round(Double.parseDouble(raw.replace(",", "")) * 100.0) / 100.0;
        } catch (NumberFormatException error) {
            return null;
        }
    }

    public static String parseDirection(String body) {
        String text = body == null ? "" : body;
        Matcher credit = CREDIT.matcher(text);
        Matcher debit = DEBIT.matcher(text);
        boolean hasCredit = credit.find();
        boolean hasDebit = debit.find();
        if (hasCredit && !hasDebit) return "credit";
        if (hasDebit && !hasCredit) return "debit";
        if (hasCredit && hasDebit) return credit.start() < debit.start() ? "credit" : "debit";
        return "credit";
    }

    public static String parseReference(String body) {
        String text = body == null ? "" : body;
        Matcher matcher = REF.matcher(text);
        if (matcher.find()) {
            String reference = cleanRef(matcher.group(1));
            if (reference.length() >= 6) return reference;
        }
        Matcher numbers = LONG_NUMBER.matcher(text);
        List<String> candidates = new ArrayList<>();
        while (numbers.find()) {
            String value = numbers.group(1);
            if (value.matches("09\\d{9}") || value.matches("63\\d{10}")) continue;
            candidates.add(value);
        }
        String best = null;
        for (String candidate : candidates) {
            if (best == null || candidate.length() > best.length()) best = candidate;
        }
        return best;
    }

    private static String cleanRef(String value) {
        return value == null ? "" : value.replaceAll("[^A-Za-z0-9-]", "").toUpperCase(Locale.US);
    }

    public static String parseCounterparty(String body) {
        String text = body == null ? "" : body.replaceAll("\\s+", " ");
        String value = firstGroup(FROM, text);
        if (value == null) value = firstGroup(TO, text);
        if (value == null) value = firstGroup(FROM_NUMBER, text);
        if (value == null) return null;
        value = value.trim().replaceAll("[.,;:]$", "");
        if (value.isEmpty() || value.matches("(?i)your|the|a|an")) return null;
        return value.length() > 80 ? value.substring(0, 80) : value;
    }

    private static String firstGroup(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        if (!matcher.find()) return null;
        return matcher.group(1);
    }

    public static String fallbackRef(String sender, String body, String receivedAt) {
        String input = (sender == null ? "" : sender) + "|" + (body == null ? "" : body) + "|" + (receivedAt == null ? "" : receivedAt);
        int hash = 0x811c9dc5;
        for (int i = 0; i < input.length(); i++) {
            hash ^= input.charAt(i);
            hash *= 0x01000193;
        }
        return String.format(Locale.US, "MSG-%08X", hash);
    }

    public static boolean isTransactionMessage(String sender, String body) {
        String text = (sender == null ? "" : sender) + " " + (body == null ? "" : body);
        String lower = text.toLowerCase(Locale.US);
        if (!(lower.contains("gcash") || lower.contains("g-cash") || lower.contains("paymaya")
                || lower.matches(".*\\bmaya\\b.*") || lower.contains("mynt"))) {
            return false;
        }
        return AMOUNT.matcher(body == null ? "" : body).find();
    }

    public static Parsed parse(String sender, String body, String receivedAt) {
        Parsed result = new Parsed();
        String cleanBody = body == null ? "" : body.trim();
        String cleanSender = sender == null ? "" : sender.trim();
        if (cleanBody.isEmpty()) {
            result.ok = false;
            result.reason = "Message body is empty.";
            return result;
        }

        Double amount = parseAmount(cleanBody);
        if (amount == null) {
            result.ok = false;
            result.reason = "No transaction amount found.";
            return result;
        }

        String provider = detectProvider(cleanSender, cleanBody);
        String direction = parseDirection(cleanBody);
        String reference = parseReference(cleanBody);
        if (reference == null || reference.length() < 6) {
            reference = fallbackRef(cleanSender, cleanBody, receivedAt);
        }

        Tx tx = new Tx();
        tx.provider = provider;
        tx.providerLabel = providerLabel(provider);
        tx.reference = reference;
        tx.amount = amount;
        tx.direction = direction;
        tx.status = "credit".equals(direction) ? "UNCLAIMED" : "SENT";
        tx.counterparty = parseCounterparty(cleanBody);
        tx.sender = cleanSender;
        tx.body = cleanBody;
        tx.receivedAt = receivedAt == null || receivedAt.isEmpty() ? Time.nowIso() : receivedAt;
        tx.source = "sms";

        result.ok = true;
        result.tx = tx;
        return result;
    }
}
