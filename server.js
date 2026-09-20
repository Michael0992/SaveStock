'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const store = require('./lib/store');
const auth = require('./lib/auth');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = Number(process.env.PORT || 3000);

store.load();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/*', limit: '1mb' }));

/* ---------------------------- Oberflaeche ----------------------------------- */

const PUBLIC = path.join(__dirname, 'public');
app.use('/assets', express.static(path.join(PUBLIC, 'assets'), { maxAge: '1h' }));

// "/" ist der Login - erst mit gueltiger Session kommt das Dashboard.
app.get('/', (req, res) => {
  const file = auth.sessionUser(req) ? 'dashboard.html' : 'login.html';
  res.sendFile(path.join(PUBLIC, file));
});

app.get('/logout', (req, res) => {
  auth.clearSession(req, res);
  res.redirect('/');
});

/* ---------------------------- Routen ---------------------------------------- */

app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `Kein Handler fuer ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[server]', err);
  res.status(status).json({ error: err.code || 'internal_error', message: err.message });
});

/* ---------------------------- Start / Stop ---------------------------------- */

const server = app.listen(PORT, () => {
  console.log(`SaveStock laeuft auf http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD_HASH && !process.env.ADMIN_PASSWORD) {
    console.warn('WARNUNG: Weder ADMIN_PASSWORD noch ADMIN_PASSWORD_HASH gesetzt - Login nicht moeglich.');
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} - schreibe Snapshot und beende.`);
  server.close(() => {
    store.shutdown();
    process.exit(0);
  });
  setTimeout(() => {
    store.shutdown();
    process.exit(0);
  }, 3001).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
