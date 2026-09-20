'use strict';
/**
 * Speicher-Engine fuer SaveStock.
 *
 * Statt einer Datenbank: In-Memory-State + Append-Only-Write-Ahead-Log (JSONL)
 * + periodischer Snapshot (Compaction).
 *
 *   data/snapshot.json  - vollstaendiger Zustand zum Zeitpunkt der letzten Compaction
 *   data/wal.jsonl      - alle Aenderungen seit dem Snapshot, eine JSON-Zeile pro Event
 *
 * Lesen ist damit reine RAM-Geschwindigkeit, Schreiben ein einzelnes Append,
 * und ein Absturz kostet hoechstens die Events die das OS noch im Puffer hatte.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOT = path.join(DATA_DIR, 'snapshot.json');
const WAL = path.join(DATA_DIR, 'wal.jsonl');

const COMPACT_AFTER_EVENTS = 500;
const STATS_FLUSH_MS = 30_000;
const MINUTE_BUCKET_LIMIT = 60 * 24; // 24h in Minutenaufloesung

const TYPES = ['string', 'int', 'float', 'bool', 'json'];

/** @type {Map<string, object>} key = stock.id (kleingeschriebener Name) */
const stocks = new Map();
let walStream = null;
let eventsSinceCompaction = 0;
let statsDirty = false;

/* ------------------------------ Hilfsfunktionen ---------------------------- */

const now = () => Date.now();
const minuteOf = (ts) => Math.floor(ts / 60000);

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function isValidName(name) {
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalizeName(name));
}

function isValidVarName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(String(name || ''));
}

function generateApiKey() {
  return 'sk_' + crypto.randomBytes(24).toString('base64url');
}

/**
 * Wandelt einen Rohwert (meist aus der URL) in den deklarierten Typ um.
 * Wirft einen Error mit .code = 'invalid_value' wenn das nicht geht.
 */
function coerce(type, raw) {
  const fail = () => {
    const err = new Error(`Wert "${raw}" passt nicht zum Typ "${type}".`);
    err.code = 'invalid_value';
    err.status = 400;
    throw err;
  };
  switch (type) {
    case 'string':
      return raw === null || raw === undefined ? '' : String(raw);
    case 'int': {
      if (typeof raw === 'number') return Number.isInteger(raw) ? raw : fail();
      const n = Number(String(raw).trim());
      return Number.isInteger(n) ? n : fail();
    }
    case 'float': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : fail();
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'off'].includes(s)) return false;
      return fail();
    }
    case 'json': {
      if (raw !== null && typeof raw === 'object') return raw;
      try {
        return JSON.parse(String(raw));
      } catch {
        return fail();
      }
    }
    default: {
      const err = new Error(`Unbekannter Typ "${type}". Erlaubt: ${TYPES.join(', ')}`);
      err.code = 'invalid_type';
      err.status = 400;
      throw err;
    }
  }
}

/* ------------------------------ Persistenz --------------------------------- */

function emptyStats() {
  return {
    calls: 0,
    reads: 0,
    writes: 0,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
    firstCallAt: null,
    lastCallAt: null,
    buckets: {}, // minuteIndex -> Anzahl Calls
  };
}

function serializeState() {
  return {
    version: 1,
    savedAt: now(),
    stocks: [...stocks.values()],
  };
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(SNAPSHOT)) {
    try {
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
      for (const stock of snap.stocks || []) {
        stock.stats = Object.assign(emptyStats(), stock.stats);
        stocks.set(stock.id, stock);
      }
    } catch (err) {
      console.error('[store] Snapshot defekt, starte mit leerem Zustand:', err.message);
    }
  }

  if (fs.existsSync(WAL)) {
    const lines = fs.readFileSync(WAL, 'utf8').split('\n');
    let replayed = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        applyEvent(JSON.parse(line));
        replayed++;
      } catch {
        // Abgeschnittene letzte Zeile nach einem Absturz - ignorieren.
      }
    }
    eventsSinceCompaction = replayed;
    if (replayed) console.log(`[store] ${replayed} Events aus dem WAL wiederhergestellt.`);
  }

  walStream = fs.createWriteStream(WAL, { flags: 'a' });
  pruneAllBuckets();
  setInterval(flushStats, STATS_FLUSH_MS).unref();
}

/** Wendet ein Event auf den In-Memory-Zustand an (Replay und Live identisch). */
function applyEvent(ev) {
  switch (ev.t) {
    case 'stock.create':
      stocks.set(ev.stock.id, { ...ev.stock, stats: Object.assign(emptyStats(), ev.stock.stats) });
      break;
    case 'stock.delete':
      stocks.delete(ev.id);
      break;
    case 'stock.rekey': {
      const s = stocks.get(ev.id);
      if (s) {
        s.apiKey = ev.apiKey;
        s.keyRotatedAt = ev.at;
      }
      break;
    }
    case 'var.set': {
      const s = stocks.get(ev.id);
      if (s) {
        const prev = s.vars[ev.name];
        s.vars[ev.name] = {
          type: ev.type,
          value: ev.value,
          createdAt: prev ? prev.createdAt : ev.at,
          updatedAt: ev.at,
          revisions: prev ? prev.revisions + 1 : 0,
        };
        s.updatedAt = ev.at;
      }
      break;
    }
    case 'var.delete': {
      const s = stocks.get(ev.id);
      if (s) {
        delete s.vars[ev.name];
        s.updatedAt = ev.at;
      }
      break;
    }
    default:
      break;
  }
}

function append(ev) {
  applyEvent(ev);
  if (walStream) walStream.write(JSON.stringify(ev) + '\n');
  if (++eventsSinceCompaction >= COMPACT_AFTER_EVENTS) compact();
}

/** Schreibt einen frischen Snapshot und leert das WAL. */
function compact() {
  const tmp = SNAPSHOT + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(serializeState()), 'utf8');
    fs.renameSync(tmp, SNAPSHOT);
    if (walStream) {
      walStream.end();
      fs.writeFileSync(WAL, '');
      walStream = fs.createWriteStream(WAL, { flags: 'a' });
    }
    eventsSinceCompaction = 0;
    statsDirty = false;
  } catch (err) {
    console.error('[store] Compaction fehlgeschlagen:', err.message);
  }
}

/** Statistiken laufen nur im RAM mit und wandern periodisch in den Snapshot. */
function flushStats() {
  if (!statsDirty) return;
  pruneAllBuckets();
  compact();
}

function shutdown() {
  pruneAllBuckets();
  compact();
  if (walStream) walStream.end();
}

/* ------------------------------ Statistik ---------------------------------- */

function pruneBuckets(stats) {
  const cutoff = minuteOf(now()) - MINUTE_BUCKET_LIMIT;
  for (const key of Object.keys(stats.buckets)) {
    if (Number(key) < cutoff) delete stats.buckets[key];
  }
}

function pruneAllBuckets() {
  for (const stock of stocks.values()) pruneBuckets(stock.stats);
}

/** Wird von der API-Middleware nach jedem Call aufgerufen. */
function recordCall(id, { kind, bytesIn = 0, bytesOut = 0, error = false }) {
  const stock = stocks.get(id);
  if (!stock) return;
  const s = stock.stats;
  const ts = now();
  s.calls++;
  if (error) s.errors++;
  else if (kind === 'read') s.reads++;
  else if (kind === 'write') s.writes++;
  s.bytesIn += bytesIn;
  s.bytesOut += bytesOut;
  s.firstCallAt = s.firstCallAt || ts;
  s.lastCallAt = ts;
  const bucket = String(minuteOf(ts));
  s.buckets[bucket] = (s.buckets[bucket] || 0) + 1;
  statsDirty = true;
}

/** Aufbereitete Kennzahlen fuer die Detailansicht. */
function statsFor(stock) {
  const s = stock.stats;
  const nowMin = minuteOf(now());
  pruneBuckets(s);

  const series = [];
  for (let i = 59; i >= 0; i--) {
    const min = nowMin - i;
    series.push({ minute: min * 60000, calls: s.buckets[String(min)] || 0 });
  }

  const last60 = series.reduce((a, b) => a + b.calls, 0);
  const values24h = Object.values(s.buckets);
  const last24h = values24h.reduce((a, b) => a + b, 0);
  const peakMinute = values24h.length ? Math.max(...values24h) : 0;
  const activeMinutes = values24h.filter((v) => v > 0).length;

  const lifetimeMinutes = s.firstCallAt ? Math.max(1, (now() - s.firstCallAt) / 60000) : 0;

  return {
    calls: s.calls,
    reads: s.reads,
    writes: s.writes,
    errors: s.errors,
    errorRate: s.calls ? s.errors / s.calls : 0,
    bytesIn: s.bytesIn,
    bytesOut: s.bytesOut,
    firstCallAt: s.firstCallAt,
    lastCallAt: s.lastCallAt,
    callsLast60Min: last60,
    callsLast24h: last24h,
    avgPerMinute60: last60 / 60,
    avgPerMinute24h: last24h / (60 * 24),
    avgPerMinuteLifetime: lifetimeMinutes ? s.calls / lifetimeMinutes : 0,
    avgPerActiveMinute: activeMinutes ? last24h / activeMinutes : 0,
    peakMinute,
    activeMinutes,
    avgBytesPerCall: s.calls ? (s.bytesIn + s.bytesOut) / s.calls : 0,
    series,
  };
}

/* ------------------------------ Public API --------------------------------- */

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function list() {
  return [...stocks.values()].map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    varCount: Object.keys(s.vars).length,
    calls: s.stats.calls,
    lastCallAt: s.stats.lastCallAt,
    avgPerMinute60: statsFor(s).avgPerMinute60,
  }));
}

function get(id) {
  return stocks.get(normalizeName(id)) || null;
}

function create(name, description = '') {
  const id = normalizeName(name);
  if (!isValidName(id)) {
    throw fail('invalid_name', 'Name: 1-63 Zeichen, nur a-z, 0-9, _ und -, Beginn alphanumerisch.');
  }
  if (stocks.has(id)) throw fail('exists', `SaveStock "${id}" existiert bereits.`, 409);

  const stock = {
    id,
    name: String(name).trim(),
    description: String(description || '').slice(0, 500),
    apiKey: generateApiKey(),
    createdAt: now(),
    updatedAt: now(),
    keyRotatedAt: null,
    vars: {},
    stats: emptyStats(),
  };
  append({ t: 'stock.create', at: now(), stock });
  return stocks.get(id);
}

function remove(id) {
  const key = normalizeName(id);
  if (!stocks.has(key)) throw fail('not_found', `SaveStock "${key}" existiert nicht.`, 404);
  append({ t: 'stock.delete', at: now(), id: key });
  return true;
}

function rotateKey(id) {
  const stock = get(id);
  if (!stock) throw fail('not_found', `SaveStock "${id}" existiert nicht.`, 404);
  const apiKey = generateApiKey();
  append({ t: 'stock.rekey', at: now(), id: stock.id, apiKey });
  return apiKey;
}

function setVar(id, name, type, rawValue) {
  const stock = get(id);
  if (!stock) throw fail('not_found', `SaveStock "${id}" existiert nicht.`, 404);
  if (!isValidVarName(name)) {
    throw fail('invalid_name', 'Variablenname: 1-64 Zeichen aus A-Z, a-z, 0-9, _, . und -');
  }
  if (!TYPES.includes(type)) {
    throw fail('invalid_type', `Unbekannter Typ "${type}". Erlaubt: ${TYPES.join(', ')}`);
  }
  const value = coerce(type, rawValue);
  append({ t: 'var.set', at: now(), id: stock.id, name, type, value });
  return stock.vars[name];
}

/** Setzt einen bestehenden Wert - der Typ bleibt erhalten. */
function updateVar(id, name, rawValue) {
  const stock = get(id);
  if (!stock) throw fail('not_found', `SaveStock "${id}" existiert nicht.`, 404);
  const existing = stock.vars[name];
  if (!existing) throw fail('not_found', `Variable "${name}" existiert nicht.`, 404);
  const value = coerce(existing.type, rawValue);
  append({ t: 'var.set', at: now(), id: stock.id, name, type: existing.type, value });
  return stock.vars[name];
}

function deleteVar(id, name) {
  const stock = get(id);
  if (!stock) throw fail('not_found', `SaveStock "${id}" existiert nicht.`, 404);
  if (!stock.vars[name]) throw fail('not_found', `Variable "${name}" existiert nicht.`, 404);
  append({ t: 'var.delete', at: now(), id: stock.id, name });
  return true;
}

/** Globale Kennzahlen fuer die Kopfzeile des Dashboards. */
function globalStats() {
  let calls = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  let vars = 0;
  let last60 = 0;
  const nowMin = minuteOf(now());
  for (const stock of stocks.values()) {
    calls += stock.stats.calls;
    bytesIn += stock.stats.bytesIn;
    bytesOut += stock.stats.bytesOut;
    vars += Object.keys(stock.vars).length;
    for (let i = 0; i < 60; i++) last60 += stock.stats.buckets[String(nowMin - i)] || 0;
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify(serializeState()));
  let diskBytes = 0;
  for (const file of [SNAPSHOT, WAL]) {
    try {
      diskBytes += fs.statSync(file).size;
    } catch {
      /* Datei noch nicht vorhanden */
    }
  }
  const mem = process.memoryUsage();

  return {
    stockCount: stocks.size,
    varCount: vars,
    traffic: { calls, bytesIn, bytesOut, bytesTotal: bytesIn + bytesOut, callsLast60Min: last60 },
    memory: {
      payloadBytes,
      diskBytes,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
    },
    walEvents: eventsSinceCompaction,
    uptimeSeconds: process.uptime(),
  };
}

module.exports = {
  TYPES,
  DATA_DIR,
  load,
  compact,
  shutdown,
  list,
  get,
  create,
  remove,
  rotateKey,
  setVar,
  updateVar,
  deleteVar,
  recordCall,
  statsFor,
  globalStats,
  coerce,
  normalizeName,
};
