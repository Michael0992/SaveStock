'use strict';

const $ = (id) => document.getElementById(id);
const origin = location.origin;
let currentStock = null;
let overviewTimer = null;

/* ------------------------------ Helfer -------------------------------------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/';
    throw new Error('not authenticated');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

function bytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const num = (n) => Number(n || 0).toLocaleString('de-DE');
const dec = (n, d = 2) => Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

function when(ts) {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'gerade eben';
  if (diff < 3600000) return `vor ${Math.floor(diff / 60000)} Min.`;
  if (diff < 86400000) return `vor ${Math.floor(diff / 3600000)} Std.`;
  return new Date(ts).toLocaleString('de-DE');
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function show(el, text, ok = false) {
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
}

function preview(value, type) {
  const s = type === 'json' ? JSON.stringify(value) : String(value);
  return esc(s.length > 60 ? `${s.slice(0, 60)}...` : s);
}

/* ------------------------------ Kennzahlen ---------------------------------- */

async function refreshOverview() {
  let data;
  try {
    data = await api('/admin/overview');
  } catch {
    return null;
  }
  $('m-stocks').textContent = num(data.stockCount);
  $('m-stocks-hint').textContent = `${num(data.varCount)} Variablen gespeichert`;

  $('m-traffic').textContent = bytes(data.traffic.bytesTotal);
  $('m-traffic-hint').textContent = `${num(data.traffic.calls)} Calls gesamt - ${num(data.traffic.callsLast60Min)} in der letzten Stunde`;

  $('m-memory').textContent = bytes(data.memory.heapUsed);
  $('m-memory-hint').textContent = `Daten ${bytes(data.memory.payloadBytes)} - auf Platte ${bytes(data.memory.diskBytes)} - RSS ${bytes(data.memory.rss)}`;

  return data;
}

/* ------------------------------ Navigation ---------------------------------- */

const VIEWS = ['create', 'list', 'options', 'detail'];

function openView(name) {
  for (const v of VIEWS) $(`view-${v}`).classList.add('hidden');
  $(`view-${name}`).classList.remove('hidden');
  document.querySelectorAll('.menu button').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name || (name === 'detail' && b.dataset.view === 'list'));
  });
  if (name !== 'detail') location.hash = name;
  if (name === 'list') renderList();
  if (name === 'options') loadOptions();
}

document.querySelectorAll('.menu button').forEach((b) => {
  b.addEventListener('click', () => openView(b.dataset.view));
});

$('back-to-list').addEventListener('click', () => openView('list'));

$('logout').addEventListener('click', async () => {
  await api('/admin/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
});

document.addEventListener('click', async (e) => {
  const copyTarget = e.target.dataset && e.target.dataset.copy;
  if (!copyTarget) return;
  try {
    await navigator.clipboard.writeText($(copyTarget).textContent);
    const old = e.target.textContent;
    e.target.textContent = 'Kopiert';
    setTimeout(() => (e.target.textContent = old), 1200);
  } catch {
    /* Clipboard ohne https nicht verfuegbar */
  }
});

/* ------------------------------ Anlegen ------------------------------------- */

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('create-msg');
  msg.classList.add('hidden');
  try {
    const { stock } = await api('/admin/stocks', {
      method: 'POST',
      body: { name: $('new-name').value, description: $('new-desc').value },
    });
    show(msg, `SaveStock "${stock.id}" angelegt.`, true);
    msg.classList.remove('hidden');
    $('create-key').textContent = stock.apiKey;
    $('create-snippet').innerHTML = snippet(stock.id, stock.apiKey);
    $('create-result').classList.remove('hidden');
    $('new-name').value = '';
    $('new-desc').value = '';
    refreshOverview();
  } catch (err) {
    show(msg, err.message);
    msg.classList.remove('hidden');
  }
});

function snippet(id, key) {
  return [
    `<span class="m">POST</span>   ${origin}/api/${id}/new_var/counter/int/0`,
    `<span class="m">GET</span>    ${origin}/api/${id}/counter`,
    `<span class="m">PUT</span>    ${origin}/api/${id}/counter/42`,
    `<span class="m">DELETE</span> ${origin}/api/${id}/counter`,
    `<span class="m">GET</span>    ${origin}/api/${id}                (alle Variablen)`,
    '',
    `curl -H "X-API-Key: ${key}" ${origin}/api/${id}`,
  ].join('\n');
}

/* ------------------------------ Uebersicht ---------------------------------- */

async function renderList() {
  const data = await refreshOverview();
  const stocks = data ? data.stocks : [];
  const body = $('list-body');

  if (!stocks.length) {
    body.innerHTML = '<div class="empty">Noch kein SaveStock angelegt.</div>';
    return;
  }

  body.innerHTML = `
    <table>
      <thead><tr>
        <th>Name</th><th class="num">Variablen</th><th class="num">API-Calls</th>
        <th class="num">&Oslash; / Min (60m)</th><th>Letzter Call</th><th>Angelegt</th>
      </tr></thead>
      <tbody>${stocks
        .map(
          (s) => `<tr>
            <td><span class="stock-link" data-stock="${esc(s.id)}">${esc(s.id)}</span>
                ${s.description ? `<div class="hint" style="font-size:12px;color:var(--muted)">${esc(s.description)}</div>` : ''}</td>
            <td class="num">${num(s.varCount)}</td>
            <td class="num">${num(s.calls)}</td>
            <td class="num">${dec(s.avgPerMinute60)}</td>
            <td>${when(s.lastCallAt)}</td>
            <td>${new Date(s.createdAt).toLocaleDateString('de-DE')}</td>
          </tr>`
        )
        .join('')}</tbody>
    </table>`;

  body.querySelectorAll('.stock-link').forEach((el) => {
    el.addEventListener('click', () => openDetail(el.dataset.stock));
  });
}

/* ------------------------------ Detail -------------------------------------- */

async function openDetail(id) {
  const { stock } = await api(`/admin/stocks/${encodeURIComponent(id)}`);
  currentStock = stock;
  openView('detail');
  renderDetail(stock);
}

function renderDetail(s) {
  const st = s.stats;
  $('d-name').textContent = s.id;
  $('d-desc').textContent = s.description || 'Keine Beschreibung.';
  $('d-key').textContent = s.apiKey;
  $('del-confirm').placeholder = s.id;
  $('del-confirm').value = '';
  $('d-snippet').innerHTML = snippet(s.id, s.apiKey);

  const stats = [
    ['API-Calls gesamt', num(st.calls)],
    ['Lesend / Schreibend', `${num(st.reads)} / ${num(st.writes)}`],
    ['Fehler', `${num(st.errors)} (${dec(st.errorRate * 100, 1)} %)`],
    ['&Oslash; Calls / Minute (60m)', dec(st.avgPerMinute60)],
    ['&Oslash; Calls / Minute (24h)', dec(st.avgPerMinute24h)],
    ['&Oslash; seit Anlage', dec(st.avgPerMinuteLifetime)],
    ['&Oslash; aktive Minute', dec(st.avgPerActiveMinute)],
    ['Spitze in einer Minute', num(st.peakMinute)],
    ['Calls letzte Stunde', num(st.callsLast60Min)],
    ['Calls letzte 24h', num(st.callsLast24h)],
    ['Traffic ein / aus', `${bytes(st.bytesIn)} / ${bytes(st.bytesOut)}`],
    ['&Oslash; Bytes pro Call', bytes(Math.round(st.avgBytesPerCall))],
    ['Erster Call', when(st.firstCallAt)],
    ['Letzter Call', when(st.lastCallAt)],
  ];
  $('d-stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  const max = Math.max(1, ...st.series.map((p) => p.calls));
  $('d-spark').innerHTML = st.series
    .map((p) => {
      const h = Math.round((p.calls / max) * 100);
      const time = new Date(p.minute).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      return `<i class="${p.calls === max && p.calls > 0 ? 'hot' : ''}" style="height:${Math.max(2, h)}%" title="${time}: ${p.calls} Calls"></i>`;
    })
    .join('');

  const names = Object.keys(s.vars).sort();
  $('d-vars').innerHTML = names.length
    ? `<table><thead><tr><th>Name</th><th>Typ</th><th>Wert</th><th class="num">Updates</th><th>Geaendert</th><th></th></tr></thead>
       <tbody>${names
         .map((n) => {
           const v = s.vars[n];
           return `<tr>
             <td class="mono">${esc(n)}</td>
             <td><span class="pill">${v.type}</span></td>
             <td class="mono">${preview(v.value, v.type)}</td>
             <td class="num">${num(v.revisions)}</td>
             <td>${when(v.updatedAt)}</td>
             <td class="num"><button class="sm danger" data-del-var="${esc(n)}">Loeschen</button></td>
           </tr>`;
         })
         .join('')}</tbody></table>`
    : '<div class="empty">Noch keine Variablen. Unten anlegen oder per API.</div>';

  $('d-vars').querySelectorAll('[data-del-var]').forEach((b) => {
    b.addEventListener('click', async () => {
      const name = b.dataset.delVar;
      if (!confirm(`Variable "${name}" wirklich loeschen?`)) return;
      await api(`/admin/stocks/${s.id}/vars/${encodeURIComponent(name)}`, { method: 'DELETE' });
      openDetail(s.id);
    });
  });
}

$('var-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('detail-msg');
  msg.classList.add('hidden');
  try {
    await api(`/admin/stocks/${currentStock.id}/vars`, {
      method: 'POST',
      body: { name: $('v-name').value, type: $('v-type').value, value: $('v-value').value },
    });
    $('v-name').value = '';
    $('v-value').value = '';
    openDetail(currentStock.id);
    refreshOverview();
  } catch (err) {
    show(msg, err.message);
    msg.classList.remove('hidden');
  }
});

$('d-rotate').addEventListener('click', async () => {
  if (!confirm('Neuen API-Key erzeugen? Der alte Key funktioniert danach nicht mehr.')) return;
  await api(`/admin/stocks/${currentStock.id}/rotate-key`, { method: 'POST' });
  openDetail(currentStock.id);
});

$('d-delete').addEventListener('click', async () => {
  const msg = $('detail-msg');
  msg.classList.add('hidden');
  try {
    await api(`/admin/stocks/${currentStock.id}`, { method: 'DELETE', body: { confirm: $('del-confirm').value } });
    currentStock = null;
    openView('list');
    refreshOverview();
  } catch (err) {
    show(msg, err.message);
    msg.classList.remove('hidden');
  }
});

/* ------------------------------ Optionen ------------------------------------ */

async function loadOptions() {
  const o = await api('/admin/options');
  $('o-user').value = o.user;
  $('o-ttl').value = o.sessionTtlMinutes;
  $('o-info').innerHTML = [
    ['Port', o.port],
    ['Passwort-Speicherung', o.passwordIsHashed ? 'scrypt-Hash' : 'Klartext in .env'],
    ['Variablentypen', o.types.join(', ')],
  ]
    .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v" style="font-size:15px">${esc(v)}</div></div>`)
    .join('');
}

$('options-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('options-msg');
  msg.classList.add('hidden');
  try {
    const res = await api('/admin/options', {
      method: 'POST',
      body: {
        currentPassword: $('o-current').value,
        user: $('o-user').value,
        newPassword: $('o-new').value,
        newPasswordRepeat: $('o-new2').value,
        sessionTtlMinutes: $('o-ttl').value,
        rotateSessionSecret: $('o-rotate').checked,
      },
    });
    if (!res.changed.length) {
      show(msg, 'Keine Aenderungen.', true);
      msg.classList.remove('hidden');
      return;
    }
    if (res.reauth) {
      show(msg, `Gespeichert (${res.changed.join(', ')}). Du wirst neu angemeldet...`, true);
      msg.classList.remove('hidden');
      setTimeout(() => (location.href = '/'), 1500);
      return;
    }
    show(msg, `Gespeichert: ${res.changed.join(', ')}`, true);
    msg.classList.remove('hidden');
    $('o-current').value = '';
    loadOptions();
  } catch (err) {
    show(msg, err.message);
    msg.classList.remove('hidden');
  }
});

/* ------------------------------ Start --------------------------------------- */

(async function init() {
  const session = await api('/admin/session').catch(() => ({ authenticated: false }));
  if (!session.authenticated) {
    location.href = '/';
    return;
  }
  $('who').textContent = `Angemeldet als ${session.user}`;
  await refreshOverview();
  openView(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'list');
  overviewTimer = setInterval(refreshOverview, 5000);
  window.addEventListener('beforeunload', () => clearInterval(overviewTimer));
})();
