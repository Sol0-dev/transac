'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store, DEMO_EMAIL, DEMO_PASSWORD } = require('./lib/store');
const { parseMessage } = require('./lib/parser');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = process.env.TRANSAC_DB || path.join(__dirname, 'data', 'db.json');
const SHOW_DEMO = process.env.TRANSAC_SHOW_DEMO !== '0';
const store = new Store(DB_FILE);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const DEMO_MESSAGES = [
  {
    id: 'gcash-credit',
    label: 'GCash · money received',
    sender: 'GCash',
    body: 'You have received PHP 500.00 from JUAN DELA CRUZ (09171234567). Ref No. 6028871884223. Date: Nov 03, 2026 10:00 AM. Your new balance is PHP 1,500.00.',
    receivedAt: new Date().toISOString(),
  },
  {
    id: 'gcash-debit',
    label: 'GCash · money sent',
    sender: 'GCash',
    body: 'PHP 250.00 sent to MARIA SANTOS (09179876543). Ref No. 6028871884999. New balance: PHP 1,250.00.',
    receivedAt: new Date().toISOString(),
  },
  {
    id: 'maya-credit',
    label: 'Maya · payment received',
    sender: 'Maya',
    body: 'Maya: You have received PHP 1,200.00 from PEDRO REYES (09175551234). Ref No. 7712345678901. Your new balance is PHP 3,450.00.',
    receivedAt: new Date().toISOString(),
  },
  {
    id: 'maya-debit',
    label: 'Maya · bill payment',
    sender: 'PayMaya',
    body: 'You have paid PHP 875.50 to MERALCO. Ref No. 8812345678902. Thank you for using Maya.',
    receivedAt: new Date().toISOString(),
  },
];

const attempts = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [key, times] of attempts) {
    const fresh = times.filter((time) => time > cutoff);
    if (fresh.length) attempts.set(key, fresh);
    else attempts.delete(key);
  }
}, 60 * 1000).unref();

function rateLimited(req, limit = 20) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const times = (attempts.get(key) || []).filter((time) => now - time < 60 * 1000);
  times.push(now);
  attempts.set(key, times);
  return times.length > limit;
}

function sendJson(res, status, payload) {
  const json = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Device-Name',
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(Object.assign(new Error('Payload too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();
  return String(req.headers['x-auth-token'] || '').trim();
}

function requireAuth(req, res) {
  const token = bearerToken(req);
  const user = store.getSessionUser(token);
  if (!user) {
    sendJson(res, 401, { error: 'Sign in required.' });
    return null;
  }
  return { user, token };
}

function resolveDevice(userId, body) {
  const device = body.device || {};
  const id = String(device.id || body.deviceId || '').trim();
  const name = String(device.name || body.deviceName || 'Phone').trim();
  const platform = String(device.platform || body.platform || 'android').trim();
  if (!id) return null;
  return store.registerDevice(userId, { id, name, platform });
}

async function handleAuth(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/auth/register' && method === 'POST') {
    if (rateLimited(req, 10)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a minute.' });
    const body = await readBody(req);
    const result = store.createUser(body);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    const token = store.createSession(result.user.id);
    return sendJson(res, 201, { token, user: result.user });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    if (rateLimited(req, 20)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a minute.' });
    const body = await readBody(req);
    const user = store.authenticate(body.email, body.password);
    if (!user) return sendJson(res, 401, { error: 'Incorrect email or password.' });
    const token = store.createSession(user.id);
    return sendJson(res, 200, { token, user });
  }

  const auth = requireAuth(req, res);
  if (!auth) return undefined;

  if (pathname === '/api/auth/me' && method === 'GET') {
    return sendJson(res, 200, { user: auth.user });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    store.destroySession(auth.token);
    return sendJson(res, 200, { ok: true });
  }

  return false;
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Device-Name',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      service: 'transac',
      time: new Date().toISOString(),
      transactions: store.data.transactions.length,
    });
  }

  if (pathname === '/api/config' && method === 'GET') {
    return sendJson(res, 200, {
      demo: SHOW_DEMO ? { email: DEMO_EMAIL, password: DEMO_PASSWORD } : null,
    });
  }

  if (pathname === '/api/demo-messages' && method === 'GET') {
    return sendJson(res, 200, { messages: DEMO_MESSAGES });
  }

  if (pathname === '/api/parse' && method === 'POST') {
    const body = await readBody(req);
    const result = parseMessage({
      sender: body.sender || '',
      body: body.body || body.text || '',
      receivedAt: body.receivedAt || Date.now(),
    });
    return sendJson(res, 200, result);
  }

  if (pathname.startsWith('/api/auth/')) {
    const handled = await handleAuth(req, res, url);
    if (handled !== false) return handled;
    return sendJson(res, 404, { error: 'Not found.' });
  }

  const auth = requireAuth(req, res);
  if (!auth) return undefined;

  if (pathname === '/api/devices' && method === 'GET') {
    return sendJson(res, 200, { devices: store.listDevices(auth.user.id) });
  }

  if (pathname === '/api/devices/register' && method === 'POST') {
    const body = await readBody(req);
    const device = resolveDevice(auth.user.id, body);
    if (!device) return sendJson(res, 400, { error: 'A device id is required.' });
    return sendJson(res, 200, { device });
  }

  if (pathname === '/api/ingest' && method === 'POST') {
    const body = await readBody(req);
    const device = resolveDevice(auth.user.id, body);
    if (!device) return sendJson(res, 400, { error: 'A device id is required.' });

    let messages = body.messages;
    if (!Array.isArray(messages)) messages = body.message ? [body.message] : [body];
    messages = messages.filter((message) => message && (message.body || message.text));
    if (!messages.length) return sendJson(res, 400, { error: 'At least one SMS message is required.' });

    const results = messages.slice(0, 100).map((message) => {
      const normalized = {
        sender: message.sender || message.address || '',
        body: message.body || message.text || '',
        receivedAt: message.receivedAt || message.timestamp || message.date || Date.now(),
        source: message.source || 'sms',
      };
      const result = store.ingest(auth.user.id, device, normalized);
      return result.ok
        ? { ok: true, duplicate: Boolean(result.duplicate), transaction: result.transaction }
        : { ok: false, reason: result.reason, message: normalized.body.slice(0, 160) };
    });

    const inserted = results.filter((item) => item.ok && !item.duplicate).length;
    const duplicates = results.filter((item) => item.ok && item.duplicate).length;
    const rejected = results.filter((item) => !item.ok).length;
    return sendJson(res, inserted || duplicates ? 201 : 200, {
      ok: true,
      inserted,
      duplicates,
      rejected,
      results,
    });
  }

  if (pathname === '/api/transactions' && method === 'GET') {
    const result = store.list(auth.user.id, {
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || 'all',
      provider: url.searchParams.get('provider') || 'all',
      deviceId: url.searchParams.get('deviceId') || '',
      limit: url.searchParams.get('limit') || 200,
      offset: url.searchParams.get('offset') || 0,
    });
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/transactions' && method === 'POST') {
    const body = await readBody(req);
    const device = resolveDevice(auth.user.id, body) || { id: 'manual', name: 'Manual entry' };
    const result = store.addManual(auth.user.id, body, device);
    if (!result.ok) return sendJson(res, 400, { error: result.reason });
    return sendJson(res, result.duplicate ? 200 : 201, {
      ok: true,
      duplicate: Boolean(result.duplicate),
      transaction: result.transaction,
    });
  }

  if (pathname === '/api/transactions/claim' && method === 'POST') {
    const body = await readBody(req);
    const transaction = store.findByReference(auth.user.id, body.provider, body.reference);
    if (!transaction) return sendJson(res, 404, { error: 'Transaction not found.' });
    const result = store.updateStatus(
      auth.user.id,
      transaction.id,
      String(body.status || '').toUpperCase(),
      body.claimedBy,
    );
    if (!result.ok) return sendJson(res, result.statusCode, { error: result.error });
    return sendJson(res, 200, { transaction: result.transaction });
  }

  const match = /^\/api\/transactions\/([A-Za-z0-9-]+)$/.exec(pathname);
  if (match) {
    const id = match[1];
    if (method === 'PATCH') {
      const body = await readBody(req);
      const result = store.updateStatus(
        auth.user.id,
        id,
        String(body.status || '').toUpperCase(),
        body.claimedBy,
      );
      if (!result.ok) return sendJson(res, result.statusCode, { error: result.error });
      return sendJson(res, 200, { transaction: result.transaction });
    }
    if (method === 'DELETE') {
      const removed = store.remove(auth.user.id, id);
      if (!removed) return sendJson(res, 404, { error: 'Transaction not found.' });
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET') {
      const transaction = store.get(auth.user.id, id);
      if (!transaction) return sendJson(res, 404, { error: 'Transaction not found.' });
      return sendJson(res, 200, { transaction });
    }
  }

  if (pathname === '/api/stats' && method === 'GET') {
    return sendJson(res, 200, store.stats(auth.user.id));
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/dashboard' || pathname === '/dashboard/') pathname = '/dashboard.html';

  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: 'Forbidden.' });
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  if (stat.isDirectory()) {
    res.writeHead(302, { Location: `${pathname.replace(/\/?$/, '')}/index.html` });
    return res.end();
  }

  const ext = path.extname(resolved).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  fs.createReadStream(resolved).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  let url = null;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else sendJson(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    if (!res.headersSent) sendJson(res, status, { error: error.message || 'Internal error.' });
    else res.end();
  } finally {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (process.env.TRANSAC_QUIET !== '1') {
      console.log(`${req.method} ${url ? url.pathname : req.url} ${res.statusCode} ${ms.toFixed(1)}ms`);
    }
  }
});

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  TRANSAC is running`);
  console.log(`  Mobile app  : http://localhost:${PORT}/`);
  console.log(`  Control room: http://localhost:${PORT}/dashboard`);
  for (const address of lanAddresses()) console.log(`  On your LAN : http://${address}:${PORT}/`);
  if (SHOW_DEMO) console.log(`  Demo login  : ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  Database    : ${DB_FILE}\n`);
});

function shutdown() {
  console.log('\n[transac] Saving data and shutting down...');
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
