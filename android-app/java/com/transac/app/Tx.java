package com.transac.app;

/** One parsed transaction, shared by the parser, database and bridge. */
public class Tx {
    public String id;
    public String provider = "unknown";
    public String providerLabel = "Other";
    public String reference;
    public double amount;
    public String currency = "PHP";
    public String direction = "credit";
    public String status = "UNCLAIMED";
    public String counterparty;
    public String sender;
    public String body;
    public String receivedAt;
    public String createdAt;
    public String deviceId;
    public String deviceName;
    public String source = "sms";
    public boolean synced;
    public String claimedBy;
    public String claimedAt;
    public boolean statusDirty;
}
