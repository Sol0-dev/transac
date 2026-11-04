'use strict';

(function () {
  const SESSION_KEY = 'transac.session.v1';
  const REFRESH_MS = 8000;

  const state = {
    token: '',
    user: null,
    transactions: [],
    devices: [],
    stats: null,
    query: '',
    status: 'all',
    provider: 'all',
    mode: 'signin',
    timer: null,
    lastRefresh: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    gate: $('gate'),
    gateError: $('gateError'),
    gateSubmit: $('gateSubmit'),
    gateName: $('gateName'),
    gateNameField: $('gateNameField'),
    gateEmail: $('gateEmail'),
    gatePassword: $('gatePassword'),
    tabSignin: $('tabSignin'),
    tabSignup: $('tabSignup'),
    shell: $('shell'),
    userAvatar: $('userAvatar'),
    userName: $('userName'),
    logoutBtn: $('logoutBtn'),
    liveDot: $('liveDot'),
    liveText: $('liveText'),
    statTotal: $('statTotal'),
    statTotalNote: $('statTotalNote'),
    statUnclaimed: $('statUnclaimed'),
    statReceived: $('statReceived'),
    statDevices: $('statDevices'),
    statDevicesNote: $('statDevicesNote'),
    search: $('search'),
    statusFilter: $('statusFilter'),
    providerFilter: $('providerFilter'),
    exportBtn: $('exportBtn'),
    rows: $('rows'),
    tableEmpty: $('tableEmpty'),
    tableNote: $('tableNote'),
    devices: $('devices'),
    lastRefresh: $('lastRefresh'),
    toast: $('toast'),
  };

  /* ------------------------------ helpers ------------------------------ */

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'AL';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }

  function readSession() {
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return saved && saved.token ? saved : null;
    } catch {
      return null;
    }
  }

  function writeSession() {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: state.token, user: state.user }));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  let toastTimer = null;
  function toast(message, kind) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', kind === 'error');
    els.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 2600);
  }

  async function api(pathname, options = {}) {
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

  function formatDateTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function money(value) {
    return `₱${Number(value || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  function deviceOnline(device) {
    return Date.now() - new Date(device.lastSeen).getTime() < 5 * 60 * 1000;
  }

  /* ------------------------------- auth -------------------------------- */

  function setMode(mode) {
    state.mode = mode;
    els.tabSignin.classList.toggle('active', mode === 'signin');
    els.tabSignup.classList.toggle('active', mode === 'signup');
    els.gateNameField.hidden = mode !== 'signup';
    els.gateSubmit.textContent = mode === 'signin' ? 'Sign in' : 'Create account';
    els.gatePassword.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
    els.gateError.textContent = '';
  }

  function showGate(message) {
    state.token = '';
    state.user = null;
    stopRefresh();
    els.shell.hidden = true;
    els.gate.hidden = false;
    els.gateError.textContent = message || '';
    setMode('signin');
  }

  function showShell() {
    els.gate.hidden = true;
    els.shell.hidden = false;
    els.userName.textContent = state.user.name;
    els.userAvatar.textContent = initials(state.user.name);
    startRefresh();
  }

  async function submitGate() {
    const email = els.gateEmail.value.trim();
    const password = els.gatePassword.value;
    const name = els.gateName.value.trim();
    els.gateError.textContent = '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      els.gateError.textContent = 'Enter a valid email address.';
      return;
    }
    if (password.length < 8) {
      els.gateError.textContent = 'Password must be at least 8 characters.';
      return;
    }
    if (state.mode === 'signup' && name.length < 2) {
      els.gateError.textContent = 'Enter your full name.';
      return;
    }

    els.gateSubmit.disabled = true;
    els.gateSubmit.textContent = state.mode === 'signin' ? 'Signing in…' : 'Creating account…';
    try {
      const pathname = state.mode === 'signin' ? '/api/auth/login' : '/api/auth/register';
      const payload = state.mode === 'signin' ? { email, password } : { name, email, password };
      const data = await api(pathname, { method: 'POST', body: JSON.stringify(payload) });
      state.token = data.token;
      state.user = data.user;
      writeSession();
      els.gatePassword.value = '';
      showShell();
      await fetchData();
    } catch (error) {
      els.gateError.textContent = error.message || 'Could not sign in.';
    } finally {
      els.gateSubmit.disabled = false;
      els.gateSubmit.textContent = state.mode === 'signin' ? 'Sign in' : 'Create account';
    }
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    clearSession();
    showGate();
  }

  /* ------------------------------ data --------------------------------- */

  function startRefresh() {
    if (state.timer) return;
    state.timer = setInterval(() => {
      if (document.visibilityState === 'visible') fetchData({ silent: true });
    }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fetchData({ silent: true });
    });
  }

  function stopRefresh() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  async function fetchData(options = {}) {
    try {
      const [stats, transactions, devices] = await Promise.all([
        api('/api/stats'),
        api('/api/transactions?limit=300'),
        api('/api/devices'),
      ]);
      state.stats = stats;
      state.transactions = Array.isArray(transactions.transactions) ? transactions.transactions : [];
      state.devices = Array.isArray(devices.devices) ? devices.devices : [];
      state.lastRefresh = new Date();
      els.liveDot.classList.remove('off');
      els.liveText.textContent = 'Live';
      render();
    } catch (error) {
      if (error.status === 401) {
        clearSession();
        showGate('Your session expired. Please sign in again.');
        return;
      }
      els.liveDot.classList.add('off');
      els.liveText.textContent = 'Offline';
      if (!options.silent) toast(error.message, 'error');
    }
  }

  /* ------------------------------ render ------------------------------- */

  function filtered() {
    const query = state.query.trim().toLowerCase();
    return state.transactions.filter((transaction) => {
      if (state.status !== 'all' && transaction.status !== state.status) return false;
      if (state.provider !== 'all' && transaction.provider !== state.provider) return false;
      if (!query) return true;
      return [
        transaction.reference,
        transaction.providerLabel,
        transaction.counterparty,
        transaction.deviceName,
        transaction.amount,
        transaction.status,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }

  function render() {
    const stats = state.stats || {};
    els.statTotal.textContent = String(stats.total || 0);
    els.statTotalNote.textContent = `${stats.gcash || 0} GCash · ${stats.maya || 0} Maya`;
    els.statUnclaimed.textContent = String(stats.unclaimed || 0);
    els.statReceived.textContent = money(stats.receivedAmount || 0);
    els.statDevices.textContent = String(stats.devices || 0);
    els.statDevicesNote.textContent = `${stats.onlineDevices || 0} online now`;

    const rows = filtered();
    els.tableNote.textContent = `${rows.length} of ${state.transactions.length} logs shown`;
    els.rows.innerHTML = rows
      .map((transaction) => {
        const amountClass = transaction.direction === 'debit' ? 'debit' : '';
        const amount = `${transaction.direction === 'credit' ? '+' : '−'}${money(transaction.amount)}`;
        const providerClass = ['gcash', 'maya'].includes(transaction.provider) ? transaction.provider : 'other';
        const claimAction =
          transaction.direction === 'credit' && transaction.status === 'UNCLAIMED'
            ? `<button class="row-action" data-claim="${escapeHtml(transaction.id)}" type="button">Claim</button>`
            : '';
        return `<tr>
          <td>${escapeHtml(formatDateTime(transaction.receivedAt))}</td>
          <td><span class="badge ${providerClass}">${escapeHtml(transaction.providerLabel)}</span></td>
          <td class="ref">${escapeHtml(transaction.reference)}</td>
          <td class="num amount ${amountClass}">${escapeHtml(amount)}</td>
          <td><span class="status ${escapeHtml(String(transaction.status).toLowerCase())}">${escapeHtml(
          transaction.status,
        )}</span></td>
          <td class="device">${escapeHtml(transaction.deviceName || '-')}</td>
          <td class="party" title="${escapeHtml(transaction.counterparty || '')}">${escapeHtml(
          transaction.counterparty || 'N/A',
        )}</td>
          <td>${claimAction}</td>
        </tr>`;
      })
      .join('');

    els.tableEmpty.hidden = rows.length > 0;

    els.devices.innerHTML = state.devices.length
      ? state.devices
          .map((device) => {
            const online = deviceOnline(device);
            return `<div class="device-card">
              <span class="device-icon">▤</span>
              <div class="device-info">
                <div class="device-name">${escapeHtml(device.name)}</div>
                <div class="device-meta">${escapeHtml(device.platform || 'device')} · ${device.count || 0} logs</div>
              </div>
              <span class="${online ? 'device-online' : 'device-offline'}">${online ? '● Online' : 'Offline'}</span>
            </div>`;
          })
          .join('')
      : '<div class="device-meta" style="padding: 4px">No devices registered yet.</div>';

    els.lastRefresh.textContent = state.lastRefresh
      ? `Updated ${state.lastRefresh.toLocaleTimeString()}`
      : '-';
  }

  function exportCsv() {
    const rows = filtered();
    const header = ['Received', 'Provider', 'Reference', 'Amount', 'Direction', 'Status', 'Device', 'From/To', 'Message'];
    const lines = [header.join(',')];
    for (const transaction of rows) {
      const values = [
        new Date(transaction.receivedAt).toISOString(),
        transaction.providerLabel,
        transaction.reference,
        transaction.amount,
        transaction.direction,
        transaction.status,
        transaction.deviceName,
        transaction.counterparty || '',
        transaction.body || '',
      ].map((value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`);
      lines.push(values.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `transac-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} log(s).`);
  }

  /* ------------------------------ events ------------------------------- */

  els.tabSignin.addEventListener('click', () => setMode('signin'));
  els.tabSignup.addEventListener('click', () => setMode('signup'));
  els.gateSubmit.addEventListener('click', submitGate);
  [els.gateEmail, els.gatePassword, els.gateName].forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitGate();
    });
  });

  els.logoutBtn.addEventListener('click', logout);
  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    render();
  });
  els.statusFilter.addEventListener('change', () => {
    state.status = els.statusFilter.value;
    render();
  });
  els.providerFilter.addEventListener('change', () => {
    state.provider = els.providerFilter.value;
    render();
  });
  els.exportBtn.addEventListener('click', exportCsv);

  els.rows.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-claim]');
    if (!button) return;
    button.disabled = true;
    try {
      await api(`/api/transactions/${button.dataset.claim}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'CLAIMED' }),
      });
      toast('Marked as claimed.');
      await fetchData({ silent: true });
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });

  /* ------------------------------- boot -------------------------------- */

  async function boot() {
    setMode('signin');
    const session = readSession();
    if (!session) {
      showGate();
      return;
    }
    state.token = session.token;
    state.user = session.user;
    try {
      const me = await api('/api/auth/me');
      state.user = me.user;
      writeSession();
      showShell();
      await fetchData();
    } catch (error) {
      if (error.status === 401) {
        clearSession();
        showGate('Your session expired. Please sign in again.');
        return;
      }
      showShell();
      await fetchData({ silent: true });
    }
  }

  boot();
})();
