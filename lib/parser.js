'use strict';

/**
 * SMS transaction parser for GCash and Maya (PayMaya) notifications.
 * Kept dependency-free so it can also run in the Android/Termux forwarder.
 */

const PROVIDERS = {
  gcash: { id: 'gcash', label: 'GCash', color: '#0072f5' },
  maya: { id: 'maya', label: 'Maya', color: '#00a651' },
  unknown: { id: 'unknown', label: 'Other', color: '#6b7280' },
};

const CREDIT_WORDS =
  /(?:received|receive|credited|credit\b|deposited|deposit\b|cash[\s-]?in|cash[\s-]?in\b|added to your|you (?:have )?got|incoming|payment received|money received)/i;
const DEBIT_WORDS =
  /(?:sent\b|send\b|paid\b|pay\b|debited|debit\b|cash[\s-]?out|withdrew|withdraw|transferred to|you paid|purchase|bills? payment)/i;

const AMOUNT_RE = /(?:php|ph₱|₱|\bp\s?)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
const AMOUNT_LABEL_RE =
  /amount\s*[:\-]?\s*(?:php|₱|\bp\b)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
const REF_RE =
  /\bref(?:erence)?(?:\s*(?:no\.?|number|num\.?|#|id))?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-]{5,})/i;
const LONG_NUMBER_RE = /\b(\d{10,20})\b/g;

/** Strip noise so reference extraction does not grab trailing punctuation. */
function cleanRef(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9-]/g, '')
    .toUpperCase();
}

function detectProvider(sender, body) {
  const from = String(sender || '').toLowerCase();
  const text = String(body || '').toLowerCase();
  if (/gcash|g-cash|mynt|2882/.test(from)) return 'gcash';
  if (/paymaya|\bmaya\b/.test(from)) return 'maya';
  if (/gcash|g-cash|mynt/.test(text)) return 'gcash';
  if (/paymaya|maya wallet|\bmaya\b/.test(text)) return 'maya';
  return 'unknown';
}

function parseAmount(body) {
  const text = String(body || '');
  const labelled = AMOUNT_LABEL_RE.exec(text);
  const direct = AMOUNT_RE.exec(text);
  const raw = (direct && direct[1]) || (labelled && labelled[1]) || null;
  if (!raw) return null;
  const value = Number.parseFloat(raw.replace(/,/g, ''));
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function parseDirection(body) {
  const text = String(body || '');
  const debit = DEBIT_WORDS.test(text);
  const credit = CREDIT_WORDS.test(text);
  if (credit && !debit) return 'credit';
  if (debit && !credit) return 'debit';
  // Messages often say "received" and "sent" only once; prefer the verb that
  // appears first in the message when both match.
  const creditAt = text.search(CREDIT_WORDS);
  const debitAt = text.search(DEBIT_WORDS);
  if (creditAt >= 0 && debitAt >= 0) return creditAt < debitAt ? 'credit' : 'debit';
  return 'credit';
}

function parseReference(body) {
  const text = String(body || '');
  const match = REF_RE.exec(text);
  if (match) {
    const ref = cleanRef(match[1]);
    if (ref.length >= 6) return ref;
  }
  // Fallback: the longest standalone digit run that is not an amount or a
  // mobile number. GCash references are commonly 13 digits.
  const numbers = [...text.matchAll(LONG_NUMBER_RE)]
    .map((m) => m[1])
    .filter((n) => !/^09\d{9}$/.test(n) && !/^63\d{10}$/.test(n) && n.length >= 10)
    .sort((a, b) => b.length - a.length);
  return numbers[0] || null;
}

function parseCounterparty(body) {
  const text = String(body || '').replace(/\s+/g, ' ');
  const patterns = [
    /\bfrom\s+([A-Za-z0-9 ._'@-]{2,60}?)(?:\s*\(|\s+Ref|\s*\.\s|\s*$)/i,
    /\bto\s+([A-Za-z0-9 ._'@-]{2,60}?)(?:\s*\(|\s+Ref|\s*\.\s|\s*$)/i,
    /\bfrom\s+([0-9+\- ]{7,20})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1]) {
      const value = m[1].trim().replace(/[.,;:]$/, '');
      if (value && !/^(your|the|a|an)$/i.test(value)) return value.slice(0, 80);
    }
  }
  return null;
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const numeric = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
  if (Number.isFinite(numeric)) {
    // Accept seconds or milliseconds.
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function fallbackRef(message) {
  // Small FNV-1a hash keeps dedupe stable without external dependencies.
  const input = `${message.sender || ''}|${message.body || ''}|${message.receivedAt || ''}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `MSG-${hash.toString(16).toUpperCase().padStart(8, '0')}`;
}

/**
 * Parse one raw SMS into a transaction draft.
 * @param {{sender?: string, body?: string, receivedAt?: string|number|Date}} message
 */
function parseMessage(message) {
  const sender = String(message.sender || '').trim();
  const body = String(message.body || '').trim();
  if (!body) {
    return { ok: false, reason: 'Message body is empty.' };
  }

  const provider = detectProvider(sender, body);
  const amount = parseAmount(body);
  if (amount === null) {
    return { ok: false, reason: 'No transaction amount found.', provider, sender, body };
  }

  const direction = parseDirection(body);
  const reference = parseReference(body) || fallbackRef({ sender, body, receivedAt: message.receivedAt });
  const receivedAt = toIso(message.receivedAt);
  const status = direction === 'credit' ? 'UNCLAIMED' : 'SENT';

  return {
    ok: true,
    transaction: {
      provider,
      providerLabel: PROVIDERS[provider].label,
      reference,
      amount,
      currency: 'PHP',
      direction,
      status,
      counterparty: parseCounterparty(body),
      sender,
      body,
      receivedAt,
    },
  };
}

/** True when an SMS looks like a GCash/Maya money movement notification. */
function isTransactionMessage(sender, body) {
  const text = `${sender || ''} ${body || ''}`;
  if (!/(gcash|g-cash|paymaya|maya|mynt)/i.test(text)) return false;
  if (!AMOUNT_RE.test(body || '')) return false;
  return true;
}

module.exports = {
  PROVIDERS,
  parseMessage,
  parseAmount,
  parseReference,
  parseDirection,
  parseCounterparty,
  detectProvider,
  isTransactionMessage,
};
