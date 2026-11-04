package com.transac.app;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/** ISO-8601 helpers. All stored timestamps are UTC and match what the web app produces. */
public final class Time {

    private static final String ISO_PATTERN = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'";

    private Time() {}

    private static SimpleDateFormat formatter() {
        SimpleDateFormat format = new SimpleDateFormat(ISO_PATTERN, Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format;
    }

    public static String nowIso() {
        return formatter().format(new Date());
    }

    public static String toIso(long millis) {
        return formatter().format(new Date(millis));
    }

    public static Date parse(String value) {
        if (value == null || value.isEmpty()) return new Date();
        try {
            return formatter().parse(value);
        } catch (ParseException error) {
            return new Date();
        }
    }

    public static String normalize(String value) {
        if (value == null || value.isEmpty()) return nowIso();
        return toIso(parse(value).getTime());
    }
}
