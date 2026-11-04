'use strict';

(function () {
  const REFRESH_MS = 12000;
  const QUEUE_KEY = 'transac.queue.v1';
  const DEVICE_KEY = 'transac.device.v1';
  const SESSION_KEY = 'transac.session.v1';
  const CACHE_KEY = 'transac.cache.v1';
  const native = window.TransacNative || null;
  const isNative = Boolean(native);

  const DEMO_MESSAGES = [
    {
      label: 'GCash · money received',
      sender: 'GCash',
      body: 'You have received PHP 500.00 from JUAN DELA CRUZ (09171234567). Ref No. 6028871884223. Date: Nov 03, 2026 10:00 AM. Your new balance is PHP 1,500.00.',
    },
    {
      label: 'GCash · money sent',
      sender: 'GCash',
      body: 'PHP 250.00 sent to MARIA SANTOS (09179876543). Ref No. 6028871884999. New balance: PHP 1,250.00.',
    },
    {
      label: 'Maya · payment received',
      sender: 'Maya',
      body: 'Maya: You have received PHP 1,200.00 from PEDRO REYES (09175551234). Ref No. 7712345678901. Your new balance is PHP 3,450.00.',
    },
    {
      label: 'Maya · bill payment',
      sender: 'PayMaya',
      body: 'You have paid PHP 875.50 to MERALCO. Ref No. 8812345678902. Thank you for using Maya.',
    },
  ];

  const state = {
    transactions: [],
    query: '',
    online: false,
    user: null,
    token: '',
    serverUrl: '',
    deviceId: '',
    deviceName: 'My Phone',
    authMode: 'signin',
    hasLocalAccount: false,
    localEmail: '',
    localName: '',
    showServerField: false,
    activeSheet: null,
    previewTimer: null,
    refreshTimer: null,
    pending: 0,
    lastSync: null,
    lastInboxScan: 0,
    claimTransaction: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    authScreen: $('authScreen'),
    authTabSignin: $('authTabSignin'),
    authTabSignup: $('authTabSignup'),
    authServerField: $('authServerField'),
    authServerUrl: $('authServerUrl'),
    authName: $('authName'),
    authNameField: document.querySelector('.auth-signup-only'),
    authEmail: $('authEmail'),
    authPassword: $('authPassword'),
    authError: $('authError'),
    authSubmit: $('authSubmit'),
    authServerToggle: $('authServerToggle'),
    authHint: $('authHint'),
    settingsBtn: $('settingsBtn'),
    searchInput: $('searchInput'),
    clearSearch: $('clearSearch'),
    connectionDot: $('connectionDot'),
    connectionText: $('connectionText'),
    deviceLabel: $('deviceLabel'),
    listSection: $('listSection'),
    txRows: $('txRows'),
    empty: $('emptyState'),
    addBtn: $('addBtn'),
    backdrop: $('backdrop'),
    logSheet: $('logSheet'),
    detailSheet: $('detailSheet'),
    settingsSheet: $('settingsSheet'),
    detailBody: $('detailBody'),
    toast: $('toast'),
    pasteSender: $('pasteSender'),
    pasteBody: $('pasteBody'),
    pastePreview: $('pastePreview'),
    pasteSubmit: $('pasteSubmit'),
    manualProvider: $('manualProvider'),
    manualDirection: $('manualDirection'),
    manualAmount: $('manualAmount'),
    manualRef: $('manualRef'),
    manualParty: $('manualParty'),
    manualDate: $('manualDate'),
    manualSubmit: $('manualSubmit'),
    demoList: $('demoList'),
    deviceNameInput: $('deviceNameInput'),
    settingsServerField: $('settingsServerField'),
    serverUrlInput: $('serverUrlInput'),
    deviceIdValue: $('deviceIdValue'),
    settingsConnection: $('settingsConnection'),
    queueCount: $('queueCount'),
    saveSettings: $('saveSettings'),
    syncNow: $('syncNow'),
    importSms: $('importSms'),
    signOut: $('signOut'),
    dashboardLink: $('dashboardLink'),
    claimBackdrop: $('claimBackdrop'),
    claimModal: $('claimModal'),
    claimSub: $('claimSub'),
    claimName: $('claimName'),
    claimError: $('claimError'),
    claimClose: $('claimClose'),
    claimCancel: $('claimCancel'),
    claimConfirm: $('claimConfirm'),
  };

  /* ------------------------------------------------------------------ */
  /* Native bridge                                                       */
  /* ------------------------------------------------------------------ */

  function callNative(method, ...args) {
    if (!native || typeof native[method] !== 'function') {
      return { ok: false, error: 'Android bridge not available.' };
    }
    try {
      const raw = native[method](...args.map((value) => (value == null ? '' : String(value))));
      if (!raw) return { ok: false, error: 'Empty native response.' };
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Local storage                                                       */
  /* ------------------------------------------------------------------ */

  function readJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value == null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full / private mode */
    }
  }

  function loadDevice() {
    const saved = readJson(DEVICE_KEY, null);
    if (saved && saved.id) return saved;
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const device = {
      id: `dev_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`,
      name: 'This phone',
    };
    writeJson(DEVICE_KEY, device);
    return device;
  }

  const device = loadDevice();

  function readSession() {
    const saved = readJson(SESSION_KEY, null);
    return saved && saved.token ? saved : null;
  }

  function saveSession() {
    writeJson(SESSION_KEY, { token: state.token, user: state.user });
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function readQueue() {
    const queue = readJson(QUEUE_KEY, []);
    return Array.isArray(queue) ? queue : [];
  }

  function writeQueue(queue) {
    writeJson(QUEUE_KEY, queue.slice(-200));
    updatePending(readQueue().length);
  }

  function enqueue(pathname, payload) {
    const queue = readQueue();
    queue.push({ pathname, payload, queuedAt: new Date().toISOString() });
    writeQueue(queue);
  }

  async function flushQueue() {
    const queue = readQueue();
    if (!queue.length) return 0;
    const remaining = [];
    let sent = 0;
    for (const entry of queue) {
      try {
        await webApi(entry.pathname, { method: 'POST', body: JSON.stringify(entry.payload) });
        sent += 1;
      } catch {
        remaining.push(entry);
      }
    }
    writeQueue(remaining);
    return sent;
  }

  function updatePending(count) {
    state.pending = count;
    els.queueCount.textContent = String(count);
    if (count > 0 && !state.online) els.connectionText.textContent = `Offline · ${count} queued`;
  }

  function saveCache(transactions) {
    writeJson(CACHE_KEY, { savedAt: new Date().toISOString(), transactions });
  }

  function loadCache() {
    const cached = readJson(CACHE_KEY, null);
    if (cached && Array.isArray(cached.transactions)) {
      state.transactions = cached.transactions;
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* HTTP (web / PWA mode)                                               */
  /* ------------------------------------------------------------------ */

  async function webApi(pathname, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const response = await fetch(pathname, { ...options, headers });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const error = new Error((data && data.error) || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  /* ------------------------------------------------------------------ */
  /* Auth                                                                */
  /* ------------------------------------------------------------------ */

  function initials(name) {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return 'AL';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    els.authTabSignin.classList.toggle('active', mode === 'signin');
    els.authTabSignup.classList.toggle('active', mode === 'signup');
    els.authNameField.hidden = mode !== 'signup';
    els.authSubmit.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
    els.authPassword.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
    els.authError.textContent = '';
    els.authName.focus({ preventScroll: true });
    if (mode === 'signin') els.authEmail.focus({ preventScroll: true });
  }

  function updateAuthHint() {
    if (!isNative) {
      els.authHint.innerHTML = 'Demo account: <strong>demo@transac.app</strong> / <strong>transac123</strong>';
      return;
    }
    if (!state.showServerField) {
      els.authHint.textContent =
        'Saved only on this phone. Allow SMS and storage when Android asks. No server or internet needed.';
    } else {
      els.authHint.innerHTML =
        'Connects to your central server. Demo account: <strong>demo@transac.app</strong> / <strong>transac123</strong>';
    }
  }

  function setServerField(visible) {
    state.showServerField = Boolean(visible);
    els.authServerField.hidden = !state.showServerField;
    els.authServerToggle.textContent = state.showServerField ? 'Use this phone only' : 'Use a central server';
    if (!state.showServerField) els.authServerUrl.value = '';
    updateAuthHint();
  }

  function showAuth(message) {
    closeSheets();
    if (isNative) {
      const status = callNative('getStatus');
      if (status && status.serverUrl) state.serverUrl = status.serverUrl;
      state.hasLocalAccount = Boolean(status && status.hasLocalAccount);
      state.localEmail = (status && status.localEmail) || state.localEmail;
      state.localName = (status && status.localName) || state.localName;
      if (state.localEmail && !els.authEmail.value) els.authEmail.value = state.localEmail;
      if (state.localName && !els.authName.value) els.authName.value = state.localName;
      setAuthMode(state.hasLocalAccount || state.serverUrl ? 'signin' : 'signup');
      setServerField(Boolean(state.serverUrl));
      els.authServerUrl.value = state.serverUrl || '';
    } else {
      setAuthMode('signin');
      els.authServerField.hidden = true;
    }
    updateAuthHint();
    els.authScreen.classList.remove('hidden');
    els.authScreen.setAttribute('aria-hidden', 'false');
    els.authError.textContent = message || '';
    setTimeout(() => els.authEmail.focus({ preventScroll: true }), 150);
  }

  function hideAuth() {
    els.authScreen.classList.add('hidden');
    els.authScreen.setAttribute('aria-hidden', 'true');
  }

  async function submitAuth() {
    const mode = state.authMode;
    const email = els.authEmail.value.trim();
    const password = els.authPassword.value;
    const name = els.authName.value.trim();
    let serverUrl = isNative ? els.authServerUrl.value.trim().replace(/\/+$/, '') : '';

    els.authError.textContent = '';
    if (isNative && !state.showServerField && !serverUrl) {
      await submitLocalAuth();
      return;
    }
    if (isNative && !serverUrl) {
      els.authError.textContent = 'Enter the server URL, e.g. http://192.168.1.10:3000';
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      els.authError.textContent = 'Enter a valid email address.';
      return;
    }
    if (password.length < 8) {
      els.authError.textContent = 'Password must be at least 8 characters.';
      return;
    }
    if (mode === 'signup' && name.length < 2) {
      els.authError.textContent = 'Enter your full name.';
      return;
    }
    if (isNative && !/^https?:\/\//i.test(serverUrl)) {
      els.authError.textContent = 'Enter the server URL, e.g. http://192.168.1.10:3000';
      return;
    }

    els.authSubmit.disabled = true;
    els.authSubmit.textContent = mode === 'signin' ? 'Signing in…' : 'Creating account…';

    try {
      if (isNative) {
        const result =
          mode === 'signin'
            ? callNative('login', serverUrl, email, password)
            : callNative('signup', serverUrl, name, email, password);
        if (!result.ok) throw new Error(result.error || 'Could not sign in.');
        state.user = result.user;
        state.serverUrl = serverUrl;
        state.deviceName = result.deviceName || state.deviceName;
        hideAuth();
      } else {
        const pathname = mode === 'signin' ? '/api/auth/login' : '/api/auth/register';
        const payload = mode === 'signin' ? { email, password } : { name, email, password };
        const data = await webApi(pathname, { method: 'POST', body: JSON.stringify(payload) });
        state.token = data.token;
        state.user = data.user;
        saveSession();
        await registerWebDevice();
        hideAuth();
      }
      els.authPassword.value = '';
      await afterAuth();
    } catch (error) {
      els.authError.textContent = error.message || 'Something went wrong.';
    } finally {
      els.authSubmit.disabled = false;
      els.authSubmit.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
    }
  }

  async function submitLocalAuth() {
    if (!isNative) return;
    let mode = state.authMode;
    const email = els.authEmail.value.trim();
    const password = els.authPassword.value;
    const name = els.authName.value.trim();

    els.authError.textContent = '';
    if (mode === 'signin' && !state.hasLocalAccount) {
      setAuthMode('signup');
      els.authError.textContent = 'Create your local account first. Add your name, then tap again.';
      return;
    }
    if (mode === 'signup' && state.hasLocalAccount) mode = 'signin';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      els.authError.textContent = 'Enter a valid email address.';
      return;
    }
    if (password.length < 8) {
      els.authError.textContent = 'Password must be at least 8 characters.';
      return;
    }
    if (mode === 'signup' && name.length < 2) {
      els.authError.textContent = 'Enter your full name.';
      return;
    }

    els.authSubmit.disabled = true;
    els.authSubmit.textContent = 'Please wait...';
    try {
      const result = callNative('localAuth', mode, name, email, password);
      if (!result.ok) throw new Error(result.error || 'Could not open the local account.');
      state.user = result.user;
      state.serverUrl = '';
      state.hasLocalAccount = true;
      state.localEmail = result.user.email || email;
      state.deviceName = result.deviceName || state.deviceName;
      els.authPassword.value = '';
      hideAuth();
      await afterAuth();
      toast('Saved on this phone. No server needed.');
    } catch (error) {
      els.authError.textContent = error.message || 'Something went wrong.';
    } finally {
      els.authSubmit.disabled = false;
      els.authSubmit.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
    }
  }

  async function registerWebDevice() {
    if (isNative || !state.token) return false;
    try {
      await webApi('/api/devices/register', {
        method: 'POST',
        body: JSON.stringify({
          device: { id: device.id, name: state.deviceName || 'Web browser', platform: 'web' },
        }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function signOut(message) {
    if (isNative) {
      callNative('logout');
    } else if (state.token) {
      try {
        await webApi('/api/auth/logout', { method: 'POST' });
      } catch {
        /* ignore */
      }
    }
    state.user = null;
    state.token = '';
    state.transactions = [];
    state.pending = 0;
    state.online = false;
    clearSession();
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(QUEUE_KEY);
    render();
    updateAvatar();
    showAuth(message || '');
  }

  async function afterAuth() {
    updateAvatar();
    startBackgroundRefresh();
    els.deviceLabel.textContent = state.deviceName;
    if (isNative) {
      const status = callNative('getStatus');
      state.serverUrl = status.serverUrl || state.serverUrl;
      state.deviceId = status.deviceId || '';
      state.deviceName = status.deviceName || state.deviceName;
      state.online = Boolean(status.online);
      updatePending(Number(status.pending) || 0);
      setConnection(state.online);
      callNative('sync');
    } else {
      state.deviceId = device.id;
      const ok = await registerWebDevice();
      if (ok) await flushQueue();
      setConnection(ok);
    }
    await refresh({ silent: true });
    if (isNative) await autoImportInbox();
  }

  function updateAvatar() {
    els.settingsBtn.textContent = initials(state.user && state.user.name);
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                          */
  /* ------------------------------------------------------------------ */

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (sameDay) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    })}`;
  }

  function formatAmount(transaction) {
    const sign = transaction.direction === 'credit' ? '+' : '−';
    const amount = Number(transaction.amount) || 0;
    return `${sign}${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
  }

  function statusClass(status) {
    return String(status || '').toLowerCase();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function matchesQuery(transaction, query) {
    if (!query) return true;
    return [
      transaction.reference,
      transaction.providerLabel,
      transaction.provider,
      transaction.counterparty,
      transaction.amount,
      transaction.status,
      transaction.deviceName,
      new Date(transaction.receivedAt).toLocaleString(),
      new Date(transaction.receivedAt).toLocaleDateString(),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query);
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  function render() {
    const query = state.query.trim().toLowerCase();
    const visible = state.transactions.filter((transaction) => matchesQuery(transaction, query));
    const fragment = document.createDocumentFragment();

    for (const transaction of visible) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tx';
      row.dataset.id = transaction.id;
      row.innerHTML = `
        <div class="tx-left">
          <div class="tx-time">
            <span class="provider-dot ${escapeHtml(transaction.provider)}"></span>
            ${escapeHtml(formatTime(transaction.receivedAt))}
          </div>
          <div class="tx-ref">${escapeHtml(transaction.reference)}</div>
        </div>
        <div class="tx-amount ${transaction.direction === 'debit' ? 'debit' : ''}">${escapeHtml(formatAmount(transaction))}</div>
        <div class="tx-status ${statusClass(transaction.status)}">${escapeHtml(transaction.status)}</div>
      `;
      fragment.appendChild(row);
    }

    els.txRows.replaceChildren(fragment);
    const hasAny = state.transactions.length > 0;
    const hasVisible = visible.length > 0;
    els.empty.classList.toggle('visible', !hasVisible);
    if (!hasVisible) {
      els.empty.querySelector('strong').textContent = hasAny ? 'No matching transactions' : 'No transactions yet';
      els.empty.querySelector('span').textContent = hasAny
        ? 'Try a different reference number, date, provider, or amount.'
        : 'Tap the + button to paste a GCash or Maya SMS. On Android, TRANSAC can also read them automatically.';
    }
    els.listSection.textContent = query
      ? `${visible.length} result${visible.length === 1 ? '' : 's'}`
      : 'Recent transactions';
  }

  function setConnection(online) {
    state.online = Boolean(online);
    const localOnly = isNative && !state.serverUrl;
    els.connectionDot.classList.toggle('offline', !online);
    if (localOnly) {
      els.connectionText.textContent = state.pending
        ? `Local mode - ${state.pending} saved`
        : 'Local mode - saved on device';
    } else if (online) {
      els.connectionText.textContent = state.pending ? `Online - ${state.pending} queued` : 'Connected';
    } else {
      els.connectionText.textContent = state.pending
        ? `Offline - ${state.pending} queued`
        : 'Offline - saved on this device';
    }
    els.deviceLabel.textContent = state.deviceName;
    els.settingsConnection.textContent = localOnly
      ? 'Local mode: no server connected. Logs stay on this phone.'
      : online
        ? 'Connected to the central logging platform.'
        : 'Working offline. New logs stay on this device until the server is reachable.';
  }

  /* ------------------------------------------------------------------ */
  /* Sheets                                                              */
  /* ------------------------------------------------------------------ */

  function openSheet(id) {
    document.querySelectorAll('.sheet.open').forEach((sheet) => {
      sheet.classList.remove('open');
      sheet.setAttribute('aria-hidden', 'true');
    });
    const sheet = $(id);
    if (!sheet) return;
    state.activeSheet = id;
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    els.backdrop.classList.add('visible');
  }

  function closeSheets() {
    document.querySelectorAll('.sheet.open').forEach((sheet) => {
      sheet.classList.remove('open');
      sheet.setAttribute('aria-hidden', 'true');
    });
    els.backdrop.classList.remove('visible');
    state.activeSheet = null;
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                               */
  /* ------------------------------------------------------------------ */

  let toastTimer = null;
  function toast(message, kind) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', kind === 'error');
    els.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 2800);
  }

  /* ------------------------------------------------------------------ */
  /* Data actions                                                        */
  /* ------------------------------------------------------------------ */

  async function fetchTransactions() {
    if (isNative) {
      const result = callNative('list', '300');
      if (result.error) throw new Error(result.error);
      return Array.isArray(result.transactions) ? result.transactions : [];
    }
    const data = await webApi('/api/transactions?limit=300');
    return Array.isArray(data.transactions) ? data.transactions : [];
  }

  async function refresh(options = {}) {
    try {
      const transactions = await fetchTransactions();
      state.transactions = transactions;
      saveCache(transactions);
      if (isNative) {
        const status = callNative('getStatus');
        if (status.signedIn === false) {
          await signOut('Your session expired. Please sign in again.');
          return;
        }
        state.online = Boolean(status.online);
        state.pending = Number(status.pending) || 0;
        state.lastSync = status.lastSync || state.lastSync;
        setConnection(state.online);
      } else {
        setConnection(true);
      }
      render();
    } catch (error) {
      if (error.status === 401) {
        await signOut('Your session expired. Please sign in again.');
        return;
      }
      if (!isNative) setConnection(false);
      if (loadCache()) render();
      if (!options.silent) toast(error.message, 'error');
    }
  }

  async function autoImportInbox() {
    if (!isNative || !state.user) return;
    if (!els.claimModal.hidden || state.activeSheet) return;
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
    if (Date.now() - state.lastInboxScan < 5 * 60 * 1000) return;
    state.lastInboxScan = Date.now();
    const result = callNative('importInbox', '0');
    if (result && result.ok && Number(result.imported) > 0) {
      await refresh({ silent: true });
    }
  }

  async function parseSms(sender, body) {
    if (isNative) return callNative('parse', sender, body);
    return webApi('/api/parse', { method: 'POST', body: JSON.stringify({ sender, body }) });
  }

  async function ingestMessage(message) {
    if (isNative) {
      const result = callNative(
        'ingest',
        message.sender || '',
        message.body || '',
        message.receivedAt || new Date().toISOString(),
        message.source || 'sms',
      );
      if (!result.ok) toast(result.error || 'Could not log that message.', 'error');
      else if (result.rejected) toast('That message does not look like a transaction.', 'error');
      else if (result.duplicate) toast('Already logged - duplicate reference skipped.');
      else toast('Transaction logged to the control center.');
      await refresh({ silent: true });
      return;
    }

    const payload = {
      device: { id: device.id, name: state.deviceName || 'This phone', platform: 'web' },
      message,
    };
    try {
      const result = await webApi('/api/ingest', { method: 'POST', body: JSON.stringify(payload) });
      if (!result) return;
      if (result.rejected) toast('That message does not look like a transaction.', 'error');
      else if (result.duplicates) toast('Already logged - duplicate reference skipped.');
      else toast('Transaction logged to the control center.');
      await refresh({ silent: true });
    } catch (error) {
      if (error.status === 401) {
        await signOut('Your session expired. Please sign in again.');
        return;
      }
      enqueue('/api/ingest', payload);
      toast('Server unreachable - saved to the offline queue.', 'error');
      setConnection(false);
    }
  }

  async function addManual(payload) {
    if (isNative) {
      const result = callNative('addManual', JSON.stringify(payload));
      if (!result.ok) toast(result.error || 'Could not save that transaction.', 'error');
      else if (result.duplicate) toast('Already logged - duplicate reference skipped.');
      else toast('Transaction saved.');
      await refresh({ silent: true });
      return;
    }
    try {
      const result = await webApi('/api/transactions', {
        method: 'POST',
        body: JSON.stringify({ ...payload, device: { id: device.id, name: state.deviceName, platform: 'web' } }),
      });
      if (result && result.duplicate) toast('Already logged - duplicate reference skipped.');
      else toast('Transaction saved.');
      await refresh({ silent: true });
    } catch (error) {
      if (error.status === 401) {
        await signOut('Your session expired. Please sign in again.');
        return;
      }
      enqueue('/api/transactions', payload);
      toast('Server unreachable - saved to the offline queue.', 'error');
      setConnection(false);
    }
  }

  async function updateStatus(id, status, claimedBy) {
    if (isNative) return callNative('updateStatus', id, status, claimedBy || '');
    return webApi(`/api/transactions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, claimedBy: claimedBy || '' }),
    });
  }

  async function removeTransaction(id) {
    if (isNative) return callNative('remove', id);
    return webApi(`/api/transactions/${id}`, { method: 'DELETE' });
  }

  /* ------------------------------------------------------------------ */
  /* Claim pop-up                                                        */
  /* ------------------------------------------------------------------ */

  function openClaimModal(transaction) {
    state.claimTransaction = transaction;
    const amount = Number(transaction.amount) || 0;
    els.claimSub.textContent = `${transaction.providerLabel} ${transaction.reference} - ₱${amount.toLocaleString(
      undefined,
      { minimumFractionDigits: 2, maximumFractionDigits: 2 },
    )}`;
    els.claimName.value = '';
    els.claimError.textContent = '';
    els.claimModal.hidden = false;
    els.claimBackdrop.hidden = false;
    requestAnimationFrame(() => {
      if (document.activeElement !== els.claimName) {
        els.claimName.focus({ preventScroll: true });
      }
    });
  }

  function closeClaimModal() {
    state.claimTransaction = null;
    els.claimModal.hidden = true;
    els.claimBackdrop.hidden = true;
    els.claimName.value = '';
    els.claimError.textContent = '';
    els.claimConfirm.disabled = false;
  }

  async function confirmClaim() {
    const transaction = state.claimTransaction;
    if (!transaction) return;
    const name = els.claimName.value.trim();
    if (name.length < 2) {
      els.claimError.textContent = "Enter the receiver's full name.";
      els.claimName.focus();
      return;
    }
    els.claimConfirm.disabled = true;
    try {
      await updateStatus(transaction.id, 'CLAIMED', name);
      toast('Marked as claimed.');
      closeClaimModal();
      closeSheets();
      await refresh({ silent: true });
    } catch (error) {
      els.claimError.textContent = error.message;
      els.claimConfirm.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Detail                                                              */
  /* ------------------------------------------------------------------ */

  function openDetail(id) {
    const transaction = state.transactions.find((item) => item.id === id);
    if (!transaction) return;
    const claimed = transaction.status === 'CLAIMED';
    const canClaim = transaction.direction === 'credit';
    const amount = Number(transaction.amount) || 0;
    els.detailBody.innerHTML = `
      <div class="detail-amount ${transaction.direction === 'debit' ? 'debit' : ''}">
        ${transaction.direction === 'credit' ? '+' : '−'}₱${amount.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </div>
      <div class="detail-sub">${escapeHtml(transaction.providerLabel)} · ${escapeHtml(transaction.reference)}</div>
      <div class="detail-status ${statusClass(transaction.status)}">${escapeHtml(transaction.status)}</div>

      <dl class="detail-grid">
        <div><dt>Reference</dt><dd>${escapeHtml(transaction.reference)}</dd></div>
        <div><dt>Provider</dt><dd>${escapeHtml(transaction.providerLabel)}</dd></div>
        <div><dt>Type</dt><dd>${transaction.direction === 'credit' ? 'Money received' : 'Money sent'}</dd></div>
        <div><dt>From / to</dt><dd>${escapeHtml(transaction.counterparty || 'N/A')}</dd></div>
        <div><dt>Received</dt><dd>${escapeHtml(new Date(transaction.receivedAt).toLocaleString())}</dd></div>
        <div><dt>Logged by</dt><dd>${escapeHtml(transaction.deviceName || 'Unknown')}</dd></div>
        ${
          transaction.claimedBy
            ? `<div><dt>Claimed by</dt><dd>${escapeHtml(transaction.claimedBy)}</dd></div>
               <div><dt>Claimed at</dt><dd>${escapeHtml(
                 transaction.claimedAt ? new Date(transaction.claimedAt).toLocaleString() : 'N/A',
               )}</dd></div>`
            : ''
        }
      </dl>

      <p class="settings-heading">Original message</p>
      <p class="raw-message">${escapeHtml(transaction.body || 'No message body stored.')}</p>

      <div class="detail-actions">
        ${
          canClaim
            ? `<button class="btn ${claimed ? 'subtle' : ''}" data-action="toggle-claim">${
                claimed ? 'Mark unclaimed' : 'Mark claimed'
              }</button>`
            : '<span></span>'
        }
        <button class="btn danger" data-action="delete">Delete log</button>
      </div>
    `;

    els.detailBody.querySelector('[data-action="toggle-claim"]')?.addEventListener('click', async () => {
      if (!claimed) {
        openClaimModal(transaction);
        return;
      }
      try {
        await updateStatus(transaction.id, 'UNCLAIMED', '');
        toast('Marked as unclaimed.');
        closeSheets();
        await refresh({ silent: true });
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    els.detailBody.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
      if (!confirm('Delete this transaction log?')) return;
      try {
        await removeTransaction(transaction.id);
        toast('Log deleted.');
        closeSheets();
        await refresh({ silent: true });
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    openSheet('detailSheet');
  }

  /* ------------------------------------------------------------------ */
  /* Log sheet                                                           */
  /* ------------------------------------------------------------------ */

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((tab) => {
      if (tab.closest('.auth-tabs')) return;
      tab.classList.toggle('active', tab.dataset.tab === name);
    });
    document.querySelectorAll('.panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `panel-${name}`);
    });
    if (name === 'demo' && !els.demoList.childElementCount) loadDemos();
  }

  async function previewPaste() {
    const body = els.pasteBody.value.trim();
    if (!body) {
      els.pastePreview.classList.add('empty-preview');
      els.pastePreview.textContent = 'Paste a message to preview what TRANSAC will read.';
      return;
    }
    try {
      const result = await parseSms(els.pasteSender.value.trim(), body);
      if (!result || !result.ok) {
        els.pastePreview.classList.add('empty-preview');
        els.pastePreview.textContent = (result && (result.reason || result.error)) || 'Could not read this message.';
        return;
      }
      const t = result.transaction;
      els.pastePreview.classList.remove('empty-preview');
      els.pastePreview.innerHTML = `
        <div class="preview-row"><span>Provider</span><span>${escapeHtml(t.providerLabel)}</span></div>
        <div class="preview-row"><span>Reference</span><span>${escapeHtml(t.reference)}</span></div>
        <div class="preview-row"><span>Amount</span><span>${t.direction === 'credit' ? '+' : '−'}₱${Number(
          t.amount,
        ).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>
        <div class="preview-row"><span>Status</span><span>${escapeHtml(t.status)}</span></div>
        <div class="preview-row"><span>From / to</span><span>${escapeHtml(t.counterparty || 'N/A')}</span></div>
      `;
    } catch {
      els.pastePreview.classList.add('empty-preview');
      els.pastePreview.textContent = 'Preview unavailable while offline. You can still log it.';
    }
  }

  function loadDemos() {
    els.demoList.innerHTML = '';
    for (const message of DEMO_MESSAGES) {
      const item = document.createElement('div');
      item.className = 'demo-item';
      item.innerHTML = `
        <div class="demo-label">${escapeHtml(message.label)}</div>
        <p>${escapeHtml(message.body)}</p>
        <button class="btn ghost" type="button">Log this SMS</button>
      `;
      item.querySelector('button').addEventListener('click', async (event) => {
        event.currentTarget.disabled = true;
        await ingestMessage({ sender: message.sender, body: message.body, source: 'demo' });
        event.currentTarget.disabled = false;
      });
      els.demoList.appendChild(item);
    }
  }

  function resetPasteForm() {
    els.pasteSender.value = '';
    els.pasteBody.value = '';
    els.pastePreview.classList.add('empty-preview');
    els.pastePreview.textContent = 'Paste a message to preview what TRANSAC will read.';
  }

  function defaultManualDate() {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  }

  function openSettings() {
    els.deviceNameInput.value = state.deviceName;
    els.serverUrlInput.value = state.serverUrl || '';
    els.deviceIdValue.textContent = state.deviceId || device.id;
    els.dashboardLink.href = isNative
      ? 'dashboard.html'
      : `${(state.serverUrl || '').replace(/\/+$/, '')}/dashboard`;
    els.settingsConnection.textContent =
      isNative && !state.serverUrl
        ? 'Local mode: no server connected. Logs stay on this phone.'
        : state.online
          ? 'Connected to the central logging platform.'
          : 'Working offline. New logs stay on this device until the server is reachable.';
    updatePending(state.pending);
    openSheet('settingsSheet');
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  els.authTabSignin.addEventListener('click', () => setAuthMode('signin'));
  els.authTabSignup.addEventListener('click', () => setAuthMode('signup'));
  els.authSubmit.addEventListener('click', submitAuth);
  els.authServerToggle.addEventListener('click', () => {
    setServerField(!state.showServerField);
    if (state.showServerField) {
      setTimeout(() => els.authServerUrl.focus({ preventScroll: true }), 60);
    }
  });
  els.authServerUrl.addEventListener('input', updateAuthHint);
  [els.authEmail, els.authPassword, els.authName, els.authServerUrl].forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitAuth();
    });
  });

  els.searchInput.addEventListener('input', () => {
    state.query = els.searchInput.value;
    els.clearSearch.classList.toggle('visible', Boolean(state.query));
    render();
  });

  els.clearSearch.addEventListener('click', () => {
    els.searchInput.value = '';
    state.query = '';
    els.clearSearch.classList.remove('visible');
    els.searchInput.focus();
    render();
  });

  els.txRows.addEventListener('click', (event) => {
    const row = event.target.closest('.tx');
    if (row) openDetail(row.dataset.id);
  });

  els.addBtn.addEventListener('click', () => {
    resetPasteForm();
    switchTab('paste');
    openSheet('logSheet');
  });

  els.settingsBtn.addEventListener('click', openSettings);
  els.backdrop.addEventListener('click', closeSheets);

  els.claimBackdrop.addEventListener('click', closeClaimModal);
  els.claimClose.addEventListener('click', closeClaimModal);
  els.claimCancel.addEventListener('click', closeClaimModal);
  els.claimConfirm.addEventListener('click', confirmClaim);
  els.claimName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') confirmClaim();
  });

  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', closeSheets));

  document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.claimModal.hidden) {
      closeClaimModal();
      return;
    }
    closeSheets();
  });

  els.pasteBody.addEventListener('input', () => {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(previewPaste, 350);
  });

  els.pasteSubmit.addEventListener('click', async () => {
    const body = els.pasteBody.value.trim();
    if (!body) {
      toast('Paste the SMS message first.', 'error');
      return;
    }
    els.pasteSubmit.disabled = true;
    await ingestMessage({
      sender: els.pasteSender.value.trim(),
      body,
      receivedAt: new Date().toISOString(),
      source: 'sms',
    });
    els.pasteSubmit.disabled = false;
    resetPasteForm();
    closeSheets();
  });

  els.manualSubmit.addEventListener('click', async () => {
    const amount = Number(els.manualAmount.value);
    const reference = els.manualRef.value.trim();
    if (!Number.isFinite(amount) || amount <= 0) {
      toast('Enter a valid amount.', 'error');
      return;
    }
    if (reference.length < 4) {
      toast('Enter the reference number.', 'error');
      return;
    }
    els.manualSubmit.disabled = true;
    await addManual({
      provider: els.manualProvider.value,
      direction: els.manualDirection.value,
      amount,
      reference,
      counterparty: els.manualParty.value.trim(),
      receivedAt: els.manualDate.value ? new Date(els.manualDate.value).toISOString() : new Date().toISOString(),
      body: `Manually logged transaction. Ref ${reference}.`,
    });
    els.manualSubmit.disabled = false;
    els.manualAmount.value = '';
    els.manualRef.value = '';
    els.manualParty.value = '';
    els.manualDate.value = defaultManualDate();
    closeSheets();
  });

  els.saveSettings.addEventListener('click', async () => {
    const name = els.deviceNameInput.value.trim() || 'My Phone';
    let serverUrl = isNative
      ? els.serverUrlInput.value.trim().replace(/\/+$/, '')
      : (state.serverUrl || '').replace(/\/+$/, '');
    if (isNative && serverUrl && !/^https?:\/\//i.test(serverUrl)) {
      toast('Server URL must start with http:// or https://', 'error');
      return;
    }
    state.deviceName = name;
    state.serverUrl = serverUrl;
    if (isNative) {
      const result = callNative('setSettings', name, serverUrl);
      if (!result.ok) {
        toast(result.error || 'Could not save settings.', 'error');
        return;
      }
      if (result.signedOut) {
        closeSheets();
        await signOut(
          serverUrl
            ? 'Server changed. Sign in again to connect to the new server.'
            : 'Server removed. Sign in on this phone or add a server again.',
        );
        return;
      }
      await refresh({ silent: true });
      toast('Settings saved.');
    } else {
      writeJson(DEVICE_KEY, { id: device.id, name });
      els.deviceLabel.textContent = name;
      const ok = await registerWebDevice();
      setConnection(ok);
      await refresh({ silent: true });
      toast('Settings saved.');
    }
    closeSheets();
  });

  els.syncNow.addEventListener('click', async () => {
    els.syncNow.disabled = true;
    if (isNative) {
      const result = callNative('sync');
      await new Promise((resolve) => setTimeout(resolve, 900));
      await refresh({ silent: true });
      const status = callNative('getStatus');
      const hasServer = Boolean((status.serverUrl || state.serverUrl || '').trim());
      if (!hasServer) {
        toast('Local mode: logs are already saved on this phone.');
      } else if (status.online && Number(status.pending) === 0) {
        toast('Everything is synced.');
      } else if (status.online) {
        toast(`${status.pending} log(s) still waiting to upload.`);
      } else {
        toast(result.error || 'Server unreachable. Logs are safe on this phone.', 'error');
      }
    } else {
      const sent = await flushQueue();
      const online = await registerWebDevice();
      setConnection(online);
      await refresh({ silent: true });
      toast(sent ? `Synced ${sent} queued message(s).` : 'Everything is up to date.');
    }
    els.syncNow.disabled = false;
  });

  els.importSms.addEventListener('click', async () => {
    if (!isNative) return;
    state.lastInboxScan = 0;
    els.importSms.disabled = true;
    const result = callNative('importInbox', '1');
    state.lastInboxScan = Date.now();
    els.importSms.disabled = false;
    if (!result.ok) {
      toast(result.error || 'Could not read SMS. Check the permission.', 'error');
      return;
    }
    toast(
      result.imported
        ? `Imported ${result.imported} transaction(s) from ${result.scanned} message(s).`
        : 'No new GCash or Maya transactions found.',
    );
    await refresh({ silent: true });
    if (result.imported) callNative('sync');
  });

  els.signOut.addEventListener('click', async () => {
    if (!confirm('Sign out on this device?')) return;
    await signOut();
  });

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  function applyNativeUI() {
    document.querySelectorAll('.native-only').forEach((element) => {
      element.hidden = !isNative;
    });
    els.authServerField.hidden = true;
    els.authServerToggle.textContent = 'Use a central server';
    els.settingsServerField.hidden = !isNative;
    els.dashboardLink.target = isNative ? '_self' : '_blank';
    updateAuthHint();
  }

  function startBackgroundRefresh() {
    if (state.refreshTimer) return;
    state.refreshTimer = setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        state.user &&
        !state.activeSheet &&
        els.claimModal.hidden
      ) {
        refresh({ silent: true });
        if (isNative) autoImportInbox();
      }
    }, REFRESH_MS);

    document.addEventListener('visibilitychange', () => {
      if (
        document.visibilityState === 'visible' &&
        state.user &&
        !state.activeSheet &&
        els.claimModal.hidden
      ) {
        refresh({ silent: true });
        if (isNative) autoImportInbox();
      }
    });

    if ('serviceWorker' in navigator && !isNative) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  window.TransacPermissionResult = function () {
    state.lastInboxScan = 0;
    autoImportInbox();
  };

  async function boot() {
    applyNativeUI();
    els.manualDate.value = defaultManualDate();
    loadCache();
    render();
    updateAvatar();
    updatePending(readQueue().length);
    startBackgroundRefresh();

    if (isNative) {
      const status = callNative('getStatus');
      state.serverUrl = status.serverUrl || '';
      state.deviceId = status.deviceId || '';
      state.deviceName = status.deviceName || 'My Phone';
      if (!status.signedIn) {
        showAuth();
        return;
      }
      state.user = status.user;
      state.online = Boolean(status.online);
      state.deviceName = status.deviceName || state.deviceName;
      hideAuth();
      await afterAuth();
    } else {
      const session = readSession();
      if (!session) {
        showAuth();
        return;
      }
      state.token = session.token;
      state.user = session.user;
      state.deviceId = device.id;
      state.deviceName = device.name || 'This phone';
      hideAuth();
      try {
        const me = await webApi('/api/auth/me');
        state.user = me.user;
        saveSession();
      } catch (error) {
        if (error.status === 401) {
          await signOut('Your session expired. Please sign in again.');
          return;
        }
      }
      await afterAuth();
    }

  }

  boot();
})();
