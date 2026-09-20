'use strict';
/**
 * Oeffentliche SaveStock-REST-API.
 *
 *   GET    /api/:stock                                  -> alle Variablen
 *   GET    /api/:stock/:var                             -> eine Variable
 *   POST   /api/:stock/new_var/:name/:type/:value       -> Variable anlegen
 *   POST   /api/:stock/new_var/:name/:type              -> Variable anlegen (Wert im Body)
 *   PUT    /api/:stock/:var/:value                      -> Wert setzen (Typ bleibt)
 *   PUT    /api/:stock/:var                             -> Wert setzen (Body {"value": ...})
 *   POST   /api/:stock/:var[/:value]                    -> wie PUT
 *   DELETE /api/:stock/:var                             -> Variable loeschen
 *
 * Authentifizierung per API-Key:
 *   Header  X-API-Key: sk_...
 *   Header  Authorization: Bearer sk_...
 *   Query   ?api_key=sk_...
 */
const express = require('express');
const crypto = require('crypto');
const store = require('../lib/store');

const router = express.Router();

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractKey(req) {
  const header = req.get('x-api-key');
  if (header) return header.trim();
  const auth = req.get('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  if (typeof req.query.api_key === 'string') return req.query.api_key.trim();
  return null;
}

/** Zaehlt jeden Call auf dem jeweiligen Stock mit - auch die fehlgeschlagenen. */
function trackAndSend(req, res, status, body, kind) {
  const payload = JSON.stringify(body);
  if (req.stockId) {
    store.recordCall(req.stockId, {
      kind,
      bytesIn: Number(req.get('content-length') || 0) + Buffer.byteLength(req.originalUrl),
      bytesOut: Buffer.byteLength(payload),
      error: status >= 400,
    });
  }
  res.status(status).type('application/json').send(payload);
}

function sendError(req, res, status, code, message) {
  trackAndSend(req, res, status, { ok: false, error: code, message }, 'error');
}

/* --------------------------- Auth-Middleware -------------------------------- */

router.use('/:stock', (req, res, next) => {
  const stock = store.get(req.params.stock);
  if (!stock) {
    return res
      .status(404)
      .json({ ok: false, error: 'not_found', message: `SaveStock "${req.params.stock}" existiert nicht.` });
  }
  req.stock = stock;
  req.stockId = stock.id;

  const key = extractKey(req);
  if (!key) {
    return sendError(req, res, 401, 'missing_api_key', 'API-Key fehlt (Header X-API-Key oder ?api_key=).');
  }
  if (!safeEqual(key, stock.apiKey)) {
    return sendError(req, res, 403, 'invalid_api_key', 'API-Key ist ungueltig.');
  }
  next();
});

/* --------------------------- Lesen ------------------------------------------ */

router.get('/:stock', (req, res) => {
  const vars = {};
  for (const [name, v] of Object.entries(req.stock.vars)) {
    vars[name] = { value: v.value, type: v.type, updatedAt: v.updatedAt };
  }
  trackAndSend(req, res, 200, { ok: true, stock: req.stock.id, count: Object.keys(vars).length, vars }, 'read');
});

/* --------------------------- Variable anlegen ------------------------------- */

router.post('/:stock/new_var/:name/:type/:value', handleNewVar);
router.post('/:stock/new_var/:name/:type', handleNewVar);
router.put('/:stock/new_var/:name/:type/:value', handleNewVar);
router.put('/:stock/new_var/:name/:type', handleNewVar);

function handleNewVar(req, res) {
  const { name, type } = req.params;
  const raw = req.params.value !== undefined ? decodeURIComponent(req.params.value) : bodyValue(req, type);
  if (req.stock.vars[name]) {
    return sendError(req, res, 409, 'exists', `Variable "${name}" existiert bereits.`);
  }
  try {
    const v = store.setVar(req.stock.id, name, type, raw);
    trackAndSend(req, res, 201, { ok: true, stock: req.stock.id, name, type: v.type, value: v.value }, 'write');
  } catch (err) {
    sendError(req, res, err.status || 400, err.code || 'bad_request', err.message);
  }
}

/** Default-Werte, damit `new_var` auch ohne Wert funktioniert. */
function bodyValue(req, type) {
  if (req.body && typeof req.body === 'object' && 'value' in req.body) return req.body.value;
  if (typeof req.body === 'string' && req.body.length) return req.body;
  return { string: '', int: 0, float: 0, bool: false, json: {} }[type];
}

/* --------------------------- Wert lesen / schreiben ------------------------- */

router.get('/:stock/:name', (req, res) => {
  const v = req.stock.vars[req.params.name];
  if (!v) {
    return sendError(req, res, 404, 'not_found', `Variable "${req.params.name}" existiert nicht.`);
  }
  trackAndSend(
    req,
    res,
    200,
    {
      ok: true,
      stock: req.stock.id,
      name: req.params.name,
      type: v.type,
      value: v.value,
      updatedAt: v.updatedAt,
      revisions: v.revisions,
    },
    'read'
  );
});

router.post('/:stock/:name/:value', handleSet);
router.put('/:stock/:name/:value', handleSet);
router.post('/:stock/:name', handleSet);
router.put('/:stock/:name', handleSet);
router.patch('/:stock/:name', handleSet);

function handleSet(req, res) {
  const { name } = req.params;
  if (!req.stock.vars[name]) {
    return sendError(
      req,
      res,
      404,
      'not_found',
      `Variable "${name}" existiert nicht - erst per /new_var/${name}/<typ>/<wert> anlegen.`
    );
  }
  const raw =
    req.params.value !== undefined
      ? decodeURIComponent(req.params.value)
      : req.body && typeof req.body === 'object' && 'value' in req.body
        ? req.body.value
        : req.body;
  try {
    const v = store.updateVar(req.stock.id, name, raw);
    trackAndSend(req, res, 200, { ok: true, stock: req.stock.id, name, type: v.type, value: v.value }, 'write');
  } catch (err) {
    sendError(req, res, err.status || 400, err.code || 'bad_request', err.message);
  }
}

/* --------------------------- Loeschen --------------------------------------- */

router.delete('/:stock/:name', (req, res) => {
  try {
    store.deleteVar(req.stock.id, req.params.name);
    trackAndSend(req, res, 200, { ok: true, stock: req.stock.id, deleted: req.params.name }, 'write');
  } catch (err) {
    sendError(req, res, err.status || 400, err.code || 'bad_request', err.message);
  }
});

module.exports = router;
