'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');

function tempStore() {
  const file = path.join(os.tmpdir(), `transac-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  return { store: new Store(file), file };
}

test('claiming requires the receiver full name and stores it', () => {
  const { store, file } = tempStore();
  try {
    const created = store.createUser({
      name: 'Store Tester',
      email: 'store@example.com',
      password: 'password123',
    });
    assert.equal(created.ok, true);
    const userId = created.user.id;

    const ingested = store.ingest(
      userId,
      { id: 'dev_test', name: 'Test Phone' },
      {
        sender: 'GCash',
        body: 'You have received PHP 500.00 from JUAN DELA CRUZ. Ref No. 6028871884223.',
        receivedAt: '2026-11-03T10:00:00.000Z',
      },
    );
    assert.equal(ingested.ok, true);
    const id = ingested.transaction.id;

    const missingName = store.updateStatus(userId, id, 'CLAIMED', '');
    assert.equal(missingName.ok, false);
    assert.equal(missingName.statusCode, 400);

    const claimed = store.updateStatus(userId, id, 'CLAIMED', 'Maria Santos');
    assert.equal(claimed.ok, true);
    assert.equal(claimed.transaction.status, 'CLAIMED');
    assert.equal(claimed.transaction.claimedBy, 'Maria Santos');
    assert.ok(claimed.transaction.claimedAt);

    const byReference = store.findByReference(userId, 'gcash', '6028871884223');
    assert.equal(byReference.claimedBy, 'Maria Santos');

    const unclaimed = store.updateStatus(userId, id, 'UNCLAIMED', '');
    assert.equal(unclaimed.ok, true);
    assert.equal(unclaimed.transaction.claimedBy, null);
    assert.equal(unclaimed.transaction.claimedAt, null);
  } finally {
    store.close();
    fs.rmSync(file, { force: true });
  }
});

test('ledger rows are scoped to their owner', () => {
  const { store, file } = tempStore();
  try {
    const first = store.createUser({ name: 'First User', email: 'first@example.com', password: 'password123' });
    const second = store.createUser({ name: 'Second User', email: 'second@example.com', password: 'password123' });
    store.ingest(
      first.user.id,
      { id: 'dev_a', name: 'Phone A' },
      {
        sender: 'Maya',
        body: 'Maya: You have received PHP 1,200.00 from PEDRO REYES. Ref No. 7712345678901.',
        receivedAt: '2026-11-03T10:00:00.000Z',
      },
    );

    assert.equal(store.list(first.user.id).total, 1);
    assert.equal(store.list(second.user.id).total, 0);
  } finally {
    store.close();
    fs.rmSync(file, { force: true });
  }
});
