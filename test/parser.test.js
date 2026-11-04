'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessage, isTransactionMessage } = require('../lib/parser');

test('parses a GCash credit message', () => {
  const result = parseMessage({
    sender: 'GCash',
    body: 'You have received PHP 500.00 from JUAN DELA CRUZ (09171234567). Ref No. 6028871884223. Date: Nov 03, 2026 10:00 AM. Your new balance is PHP 1,500.00.',
    receivedAt: '2026-11-03T02:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.transaction.provider, 'gcash');
  assert.equal(result.transaction.amount, 500);
  assert.equal(result.transaction.reference, '6028871884223');
  assert.equal(result.transaction.direction, 'credit');
  assert.equal(result.transaction.status, 'UNCLAIMED');
  assert.match(result.transaction.counterparty, /JUAN DELA CRUZ/);
});

test('parses a Maya debit message', () => {
  const result = parseMessage({
    sender: 'PayMaya',
    body: 'You have paid PHP 875.50 to MERALCO. Ref No. 8812345678902. Thank you for using Maya.',
    receivedAt: '2026-11-03T02:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.transaction.provider, 'maya');
  assert.equal(result.transaction.amount, 875.5);
  assert.equal(result.transaction.reference, '8812345678902');
  assert.equal(result.transaction.direction, 'debit');
  assert.equal(result.transaction.status, 'SENT');
});

test('parses the peso sign and comma amounts', () => {
  const result = parseMessage({
    sender: 'Maya',
    body: 'Maya: You have received ₱1,200.00 from PEDRO REYES (09175551234). Ref No. 7712345678901.',
  });
  assert.equal(result.ok, true);
  assert.equal(result.transaction.amount, 1200);
  assert.equal(result.transaction.direction, 'credit');
});

test('rejects a message without an amount', () => {
  const result = parseMessage({ sender: 'GCash', body: 'Your GCash account is now verified.' });
  assert.equal(result.ok, false);
});

test('falls back to a stable reference when none is present', () => {
  const message = {
    sender: 'GCash',
    body: 'You have received PHP 100.00 from a friend.',
    receivedAt: '2026-11-03T02:00:00.000Z',
  };
  const first = parseMessage(message).transaction.reference;
  const second = parseMessage(message).transaction.reference;
  assert.match(first, /^MSG-[0-9A-F]{8}$/);
  assert.equal(first, second);
});

test('detects transaction messages only', () => {
  assert.equal(isTransactionMessage('GCash', 'You have received PHP 500.00. Ref 1234567890123'), true);
  assert.equal(isTransactionMessage('GCash', 'Your account is verified.'), false);
  assert.equal(isTransactionMessage('Bank', 'You have received PHP 500.00'), false);
});
