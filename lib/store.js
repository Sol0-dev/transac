'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseMessage, PROVIDERS } = require('./parser');

const MAX_TRANSACTIONS = 5000;
const SESSION_DAYS = 30;
const DEMO_EMAIL = 'demo@transac.app';
const DEMO_PASSWORD = 'transac123';

function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHex) {
  try {
    const actual = Buffer.from(hashPassword(password, salt), 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function newUser(name, email, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: `usr_${crypto.randomBytes(8).toString('hex')}`,
    name,
    email,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt };
}

function seedTransactions(userId, deviceId, deviceName) {
  const refs = ['6028871884223', '6028871884231', '6028871884240', '6028871884258', '6028871884266'];
  const times = [todayAt(10, 0), todayAt(9, 45), todayAt(9, 30), todayAt(9, 15), todayAt(9, 0)];
  const now = Date.now();
  return refs.map((reference, index) => ({
    id: crypto.randomUUID(),
    userId,
    provider: 'gcash',
    providerLabel: 'GCash',
    reference,
    amount: 500,
    currency: 'PHP',
    direction: 'credit',
    status: 'UNCLAIMED',
    counterparty: 'GCash user',
    sender: 'GCash',
    body: `You have received PHP 500.00 from GCash user. Ref No. ${reference}`,
    receivedAt: times[index],
    createdAt: new Date(now - index * 1000).toISOString(),
    deviceId,
    deviceName,
    source: 'seed',
  }));
}

function buildInitialData() {
  const now = new Date().toISOString();
  const demo = newUser('Demo User', DEMO_EMAIL, DEMO_PASSWORD);
  const device = {
    id: 'dev_demo',
    userId: demo.id,
    name: 'Demo Phone',
    platform: 'android',
    createdAt: now,
    lastSeen: now,
    count: 5,
  };
  const transactions = seedTransactions(demo.id, device.id, device.name);
  return {
    version: 2,
    users: { [demo.id]: demo },
    sessions: {},
    devices: { [demo.id]: { [device.id]: device } },
    transactions,
  };
}

function dedupeKey(transaction) {
  return `${transaction.userId || ''}:${transaction.provider}:${transaction.reference}`.toLowerCase();
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.timer = null;
    this.closed = false;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.transactions)) throw new Error('Unexpected database shape.');
      this.data = this.migrate(parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[store] Could not read ${this.file}: ${error.message}. Starting fresh.`);
      }
      this.data = buildInitialData();
      this.scheduleSave();
    }
  }

  /** Bring v1 demo data forward without losing transactions. */
  migrate(parsed) {
    if (parsed.version === 2 && parsed.users && parsed.sessions && parsed.devices) return parsed;

    const data = parsed;
    data.users = data.users || {};
    data.sessions = data.sessions || {};
    data.devices = data.devices || {};
    data.transactions = data.transactions || [];

    if (!Object.keys(data.users).length) {
      const demo = newUser('Demo User', DEMO_EMAIL, DEMO_PASSWORD);
      data.users[demo.id] = demo;
      for (const transaction of data.transactions) {
        if (!transaction.userId) transaction.userId = demo.id;
      }
      // Re-key devices by owner for v1 data.
      const rekeyed = {};
      for (const device of Object.values(data.devices)) {
        const userId = device.userId || demo.id;
        device.userId = userId;
        rekeyed[userId] = rekeyed[userId] || {};
        rekeyed[userId][device.id] = device;
      }
      data.devices = rekeyed;
    }
    data.version = 2;
    this.scheduleSave();
    return data;
  }

  scheduleSave() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, 150);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error(`[store] Save failed: ${error.message}`);
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.saveNow();
  }

  close() {
    this.flush();
    this.closed = true;
  }

  /* ----------------------------- users ----------------------------- */

  findUserByEmail(email) {
    const target = String(email || '').trim().toLowerCase();
    return Object.values(this.data.users).find((user) => user.email === target) || null;
  }

  createUser({ name, email, password }) {
    const cleanName = String(name || '').trim().slice(0, 60);
    const cleanEmail = String(email || '').trim().toLowerCase().slice(0, 160);
    const cleanPassword = String(password || '');

    if (cleanName.length < 2) return { ok: false, error: 'Enter your full name.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return { ok: false, error: 'Enter a valid email address.' };
    if (cleanPassword.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
    if (this.findUserByEmail(cleanEmail)) return { ok: false, error: 'An account with that email already exists.' };

    const user = newUser(cleanName, cleanEmail, cleanPassword);
    this.data.users[user.id] = user;
    this.data.devices[user.id] = {};
    this.scheduleSave();
    return { ok: true, user: publicUser(user) };
  }

  authenticate(email, password) {
    const user = this.findUserByEmail(email);
    if (!user) return null;
    if (!verifyPassword(String(password || ''), user.salt, user.passwordHash)) return null;
    return publicUser(user);
  }

  /* --------------------------- sessions ---------------------------- */

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.data.sessions[token] = {
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    };
    this.scheduleSave();
    return token;
  }

  getSessionUser(token) {
    if (!token) return null;
    const session = this.data.sessions[token];
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      delete this.data.sessions[token];
      this.scheduleSave();
      return null;
    }
    const user = this.data.users[session.userId];
    return publicUser(user);
  }

  destroySession(token) {
    if (token && this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.scheduleSave();
    }
  }

  /* ---------------------------- devices ---------------------------- */

  registerDevice(userId, { id, name, platform } = {}) {
    if (!userId || !id || typeof id !== 'string') return null;
    const cleanId = id.slice(0, 80);
    const bucket = (this.data.devices[userId] = this.data.devices[userId] || {});
    const existing = bucket[cleanId] || {
      id: cleanId,
      userId,
      createdAt: new Date().toISOString(),
      count: 0,
    };
    const now = new Date().toISOString();
    existing.name = String(name || existing.name || 'Phone').slice(0, 60);
    existing.platform = String(platform || existing.platform || 'android').slice(0, 30);
    existing.lastSeen = now;
    bucket[cleanId] = existing;
    this.scheduleSave();
    return existing;
  }

  listDevices(userId) {
    return Object.values(this.data.devices[userId] || {}).sort(
      (a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime(),
    );
  }

  /* ------------------------- transactions -------------------------- */

  findDuplicate(userId, transaction) {
    const key = dedupeKey({ ...transaction, userId });
    return this.data.transactions.find((item) => dedupeKey(item) === key) || null;
  }

  ingest(userId, device, rawMessage) {
    const parsed = parseMessage(rawMessage);
    if (!parsed.ok) return parsed;

    const duplicate = this.findDuplicate(userId, parsed.transaction);
    if (duplicate) return { ok: true, duplicate: true, transaction: duplicate };

    const transaction = {
      id: crypto.randomUUID(),
      userId,
      ...parsed.transaction,
      createdAt: new Date().toISOString(),
      deviceId: device && device.id ? device.id : 'unknown',
      deviceName: device && device.name ? device.name : 'Unknown device',
      source: rawMessage.source || 'sms',
    };

    this.data.transactions.unshift(transaction);
    if (this.data.transactions.length > MAX_TRANSACTIONS) this.data.transactions.length = MAX_TRANSACTIONS;

    const entry = this.data.devices[userId] && this.data.devices[userId][transaction.deviceId];
    if (entry) {
      entry.count = (entry.count || 0) + 1;
      entry.lastSeen = new Date().toISOString();
    }
    this.scheduleSave();
    return { ok: true, duplicate: false, transaction };
  }

  addManual(userId, input, device) {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'A positive amount is required.' };
    const provider = PROVIDERS[input.provider] ? input.provider : 'unknown';
    const direction = input.direction === 'debit' ? 'debit' : 'credit';
    const reference = String(input.reference || '').trim().toUpperCase().slice(0, 40);
    if (!reference || reference.length < 4) return { ok: false, reason: 'A reference number is required.' };

    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
    const draft = {
      provider,
      providerLabel: PROVIDERS[provider].label,
      reference,
      amount: Math.round(amount * 100) / 100,
      currency: 'PHP',
      direction,
      status: direction === 'credit' ? 'UNCLAIMED' : 'SENT',
      counterparty: String(input.counterparty || '').slice(0, 80) || null,
      sender: 'Manual entry',
      body: String(input.body || '').slice(0, 1000),
      receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date().toISOString() : receivedAt.toISOString(),
    };

    const duplicate = this.findDuplicate(userId, draft);
    if (duplicate) return { ok: true, duplicate: true, transaction: duplicate };

    const transaction = {
      id: crypto.randomUUID(),
      userId,
      ...draft,
      createdAt: new Date().toISOString(),
      deviceId: device && device.id ? device.id : 'manual',
      deviceName: device && device.name ? device.name : 'Manual entry',
      source: 'manual',
    };
    this.data.transactions.unshift(transaction);

    const entry = this.data.devices[userId] && this.data.devices[userId][transaction.deviceId];
    if (entry) {
      entry.count = (entry.count || 0) + 1;
      entry.lastSeen = new Date().toISOString();
    }
    this.scheduleSave();
    return { ok: true, duplicate: false, transaction };
  }

  list(userId, { q, status, provider, deviceId, limit = 200, offset = 0 } = {}) {
    const query = String(q || '').trim().toLowerCase();
    const filtered = this.data.transactions.filter((item) => {
      if (item.userId !== userId) return false;
      if (status && status !== 'all' && item.status !== status) return false;
      if (provider && provider !== 'all' && item.provider !== provider) return false;
      if (deviceId && item.deviceId !== deviceId) return false;
      if (!query) return true;
      return [
        item.reference,
        item.providerLabel,
        item.counterparty,
        item.deviceName,
        item.amount,
        item.status,
        new Date(item.receivedAt).toLocaleString(),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(1000, Math.max(1, Number(limit) || 200));
    return { total: filtered.length, transactions: filtered.slice(start, start + size) };
  }

  get(userId, id) {
    return this.data.transactions.find((item) => item.id === id && item.userId === userId) || null;
  }

  findByReference(userId, provider, reference) {
    const cleanProvider = String(provider || '').toLowerCase();
    const cleanReference = String(reference || '').trim().toUpperCase();
    return (
      this.data.transactions.find(
        (item) =>
          item.userId === userId &&
          item.provider === cleanProvider &&
          item.reference === cleanReference,
      ) || null
    );
  }

  updateStatus(userId, id, status, claimedBy) {
    const allowed = ['UNCLAIMED', 'CLAIMED', 'SENT'];
    if (!allowed.includes(status)) {
      return { ok: false, statusCode: 400, error: 'Invalid status.' };
    }
    const transaction = this.get(userId, id);
    if (!transaction) {
      return { ok: false, statusCode: 404, error: 'Transaction not found.' };
    }

    const receiver = String(claimedBy || '').trim().slice(0, 80);
    if (status === 'CLAIMED') {
      if (receiver.length < 2) {
        return { ok: false, statusCode: 400, error: "Enter the receiver's full name." };
      }
      transaction.claimedBy = receiver;
      transaction.claimedAt = new Date().toISOString();
    } else {
      transaction.claimedBy = null;
      transaction.claimedAt = null;
    }

    transaction.status = status;
    transaction.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return { ok: true, transaction };
  }

  remove(userId, id) {
    const index = this.data.transactions.findIndex((item) => item.id === id && item.userId === userId);
    if (index === -1) return false;
    this.data.transactions.splice(index, 1);
    this.scheduleSave();
    return true;
  }

  stats(userId) {
    const transactions = this.data.transactions.filter((item) => item.userId === userId);
    const credits = transactions.filter((item) => item.direction === 'credit');
    const now = Date.now();
    const devices = this.listDevices(userId);
    return {
      total: transactions.length,
      unclaimed: transactions.filter((item) => item.status === 'UNCLAIMED').length,
      claimed: transactions.filter((item) => item.status === 'CLAIMED').length,
      sent: transactions.filter((item) => item.status === 'SENT').length,
      receivedAmount: Math.round(credits.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
      gcash: transactions.filter((item) => item.provider === 'gcash').length,
      maya: transactions.filter((item) => item.provider === 'maya').length,
      devices: devices.length,
      onlineDevices: devices.filter((device) => now - new Date(device.lastSeen).getTime() < 5 * 60 * 1000).length,
      lastIngestAt: transactions.length ? transactions[0].createdAt : null,
    };
  }
}

module.exports = { Store, buildInitialData, DEMO_EMAIL, DEMO_PASSWORD };
