'use strict';
/** Interne API hinter dem Login - versorgt das Dashboard. */
const express = require('express');
const crypto = require('crypto');
const store = require('../lib/store');
const auth = require('../lib/auth');
const { updateEnvFile } = require('../lib/env');

const router = express.Router();

/* --------------------------- Login-Bremse ----------------------------------- */

const attempts = new Map(); // ip -> { count, until }
const MAX_ATTEMPTS = 8;
const LOCK_MS = 5 * 60 * 1000;

function throttle(ip) {
  const entry = attempts.get(ip);
  if (entry && entry.until > Date.now()) {
    return Math.ceil((entry.until - Date.now()) / 1000);
  }
  return 0;
}

function noteFailure(ip) {
  const entry = attempts.get(ip) || { count: 0, until: 0 };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.until = Date.now() + LOCK_MS;
    entry.count = 0;
  }
  attempts.set(ip, entry);
}

/* --------------------------- Session ---------------------------------------- */

router.get('/session', (req, res) => {
  const user = auth.sessionUser(req);
  res.json({ authenticated: Boolean(user), user });
});

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const wait = throttle(ip);
  if (wait) {
    return res.status(429).json({
      error: 'too_many_attempts',
      message: `Zu viele Fehlversuche. Bitte ${wait}s warten.`,
    });
  }

  const { user, password } = req.body || {};
  if (!auth.checkLogin(user, password)) {
    noteFailure(ip);
    return res.status(401).json({ error: 'invalid_credentials', message: 'Benutzer oder Passwort falsch.' });
  }

  attempts.delete(ip);
  auth.setSession(req, res, String(user));
  res.json({ ok: true, user });
});

router.post('/logout', (req, res) => {
  auth.clearSession(req, res);
  res.json({ ok: true });
});

// Alles ab hier braucht eine gueltige Session.
router.use(auth.requireAuth);

/* --------------------------- Uebersicht ------------------------------------- */

router.get('/overview', (req, res) => {
  res.json({ ...store.globalStats(), stocks: store.list() });
});

/* --------------------------- SaveStocks ------------------------------------- */

router.get('/stocks', (req, res) => {
  res.json({ stocks: store.list() });
});

router.post('/stocks', (req, res, next) => {
  try {
    const stock = store.create(req.body?.name, req.body?.description);
    res.status(201).json({ ok: true, stock: detail(stock) });
  } catch (err) {
    next(err);
  }
});

router.get('/stocks/:id', (req, res) => {
  const stock = store.get(req.params.id);
  if (!stock) return res.status(404).json({ error: 'not_found', message: 'SaveStock existiert nicht.' });
  res.json({ stock: detail(stock) });
});

router.post('/stocks/:id/rotate-key', (req, res, next) => {
  try {
    res.json({ ok: true, apiKey: store.rotateKey(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/stocks/:id', (req, res, next) => {
  try {
    // Sicherheitsnetz: der Name muss zur Bestaetigung mitgeschickt werden.
    const confirm = store.normalizeName(req.body?.confirm);
    if (confirm !== store.normalizeName(req.params.id)) {
      return res.status(400).json({
        error: 'confirm_mismatch',
        message: 'Zum Loeschen den Namen des SaveStocks exakt bestaetigen.',
      });
    }
    store.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- Variablen (Dashboard) -------------------------- */

router.post('/stocks/:id/vars', (req, res, next) => {
  try {
    const { name, type, value } = req.body || {};
    const v = store.setVar(req.params.id, name, type, value);
    res.status(201).json({ ok: true, name, variable: v });
  } catch (err) {
    next(err);
  }
});

router.put('/stocks/:id/vars/:name', (req, res, next) => {
  try {
    const v = store.updateVar(req.params.id, req.params.name, req.body?.value);
    res.json({ ok: true, name: req.params.name, variable: v });
  } catch (err) {
    next(err);
  }
});

router.delete('/stocks/:id/vars/:name', (req, res, next) => {
  try {
    store.deleteVar(req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- Optionen --------------------------------------- */

router.get('/options', (req, res) => {
  res.json({
    user: process.env.ADMIN_USER || 'admin',
    passwordIsHashed: Boolean(process.env.ADMIN_PASSWORD_HASH),
    port: Number(process.env.PORT || 3000),
    sessionTtlMinutes: Number(process.env.SESSION_TTL_MINUTES || 120),
    types: store.TYPES,
  });
});

router.post('/options', (req, res) => {
  const { currentPassword, user, newPassword, newPasswordRepeat, sessionTtlMinutes, rotateSessionSecret } =
    req.body || {};

  if (!auth.checkLogin(req.adminUser, currentPassword)) {
    return res
      .status(401)
      .json({ error: 'invalid_credentials', message: 'Aktuelles Passwort stimmt nicht.' });
  }

  const updates = {};

  if (user && user !== process.env.ADMIN_USER) {
    if (!/^[\w.@+-]{2,64}$/.test(user)) {
      return res.status(400).json({ error: 'invalid_user', message: 'Benutzername: 2-64 Zeichen (Buchstaben, Ziffern, . _ - + @).' });
    }
    updates.ADMIN_USER = user;
  }

  if (newPassword) {
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'weak_password', message: 'Passwort braucht mindestens 8 Zeichen.' });
    }
    if (newPassword !== newPasswordRepeat) {
      return res.status(400).json({ error: 'mismatch', message: 'Die beiden Passwoerter stimmen nicht ueberein.' });
    }
    // In der .env landet nur noch der scrypt-Hash, das Klartextfeld wird geleert.
    updates.ADMIN_PASSWORD_HASH = auth.hashPassword(newPassword);
    updates.ADMIN_PASSWORD = '';
  }

  if (sessionTtlMinutes !== undefined && sessionTtlMinutes !== '') {
    const ttl = Number(sessionTtlMinutes);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 60 * 24 * 30) {
      return res.status(400).json({ error: 'invalid_ttl', message: 'Session-Laufzeit: 1 bis 43200 Minuten.' });
    }
    updates.SESSION_TTL_MINUTES = Math.round(ttl);
  }

  if (rotateSessionSecret) {
    updates.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  }

  if (!Object.keys(updates).length) {
    return res.json({ ok: true, changed: [], reauth: false });
  }

  try {
    updateEnvFile(updates);
  } catch (err) {
    return res.status(500).json({ error: 'env_write_failed', message: `.env konnte nicht geschrieben werden: ${err.message}` });
  }

  // Benutzer/Passwort/Secret machen alle bestehenden Sessions ungueltig.
  const reauth = Boolean(updates.ADMIN_USER || updates.ADMIN_PASSWORD_HASH || updates.SESSION_SECRET);
  if (reauth) auth.clearSession(req, res);
  else auth.setSession(req, res, req.adminUser); // neue TTL sofort anwenden

  res.json({ ok: true, changed: Object.keys(updates), reauth });
});

/* --------------------------- Helfer ----------------------------------------- */

function detail(stock) {
  return {
    id: stock.id,
    name: stock.name,
    description: stock.description,
    apiKey: stock.apiKey,
    createdAt: stock.createdAt,
    updatedAt: stock.updatedAt,
    keyRotatedAt: stock.keyRotatedAt,
    vars: stock.vars,
    stats: store.statsFor(stock),
  };
}

module.exports = router;
