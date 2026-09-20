'use strict';
const crypto = require('crypto');

const COOKIE_NAME = 'savestock_session';

/* ---------------- Passwort-Hashing (scrypt, ohne externe Abhaengigkeit) ------ */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt$')) {
    // Klartext-Passwort aus der .env
    return timingSafeEqualStr(password, stored);
  }
  const [, saltHex, keyHex] = stored.split('$');
  if (!saltHex || !keyHex) return false;
  let key;
  try {
    key = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  } catch {
    return false;
  }
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ---------------- Aktuelle Zugangsdaten aus der Umgebung -------------------- */

function currentCredentials() {
  return {
    user: process.env.ADMIN_USER || 'admin',
    secret: process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD || '',
  };
}

function checkLogin(user, password) {
  const cur = currentCredentials();
  if (!cur.secret) return false;
  // Beide Vergleiche immer ausfuehren, damit die Laufzeit nicht verraet welcher fehlschlug.
  const userOk = timingSafeEqualStr(user || '', cur.user);
  const passOk = verifyPassword(password || '', cur.secret);
  return userOk && passOk;
}

/* ---------------- Stateless Session-Token (HMAC) ---------------------------- */

function sessionSecret() {
  return process.env.SESSION_SECRET || 'insecure-default-secret';
}

// Aendern sich die Zugangsdaten, werden alle ausgestellten Tokens ungueltig.
function credentialFingerprint() {
  const cur = currentCredentials();
  return crypto.createHash('sha256').update(`${cur.user}\u0000${cur.secret}`).digest('hex').slice(0, 16);
}

function ttlMs() {
  const minutes = Number(process.env.SESSION_TTL_MINUTES || 120);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 120) * 60_000;
}

function sign(data) {
  return crypto.createHmac('sha256', sessionSecret()).update(data).digest('base64url');
}

function issueToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ u: user, fp: credentialFingerprint(), exp: Date.now() + ttlMs() })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  if (!timingSafeEqualStr(signature, sign(payload))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || data.exp < Date.now()) return null;
  if (data.fp !== credentialFingerprint()) return null;
  return data;
}

/* ---------------- Express-Middleware ---------------------------------------- */

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.protocol === 'https',
    maxAge: ttlMs(),
    path: '/',
  };
}

function setSession(req, res, user) {
  res.cookie(COOKIE_NAME, issueToken(user), cookieOptions(req));
}

function clearSession(req, res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(req), maxAge: undefined });
}

function sessionUser(req) {
  const data = readToken(req.cookies ? req.cookies[COOKIE_NAME] : null);
  return data ? data.u : null;
}

function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'not_authenticated', message: 'Bitte einloggen.' });
  }
  req.adminUser = user;
  next();
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  checkLogin,
  currentCredentials,
  setSession,
  clearSession,
  sessionUser,
  requireAuth,
};
