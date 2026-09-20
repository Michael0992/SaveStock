'use strict';
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

/**
 * Schreibt Werte in die .env zurueck, ohne Kommentare oder Reihenfolge zu zerstoeren.
 * Keys die es noch nicht gibt werden angehaengt. `null` entfernt einen Key.
 */
function updateEnvFile(updates) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  }
  const remaining = new Map(Object.entries(updates));

  const out = [];
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && remaining.has(m[1])) {
      const key = m[1];
      const value = remaining.get(key);
      remaining.delete(key);
      if (value === null) continue;
      out.push(`${key}=${serialize(value)}`);
    } else {
      out.push(line);
    }
  }

  for (const [key, value] of remaining) {
    if (value === null) continue;
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(`${key}=${serialize(value)}`);
  }

  fs.writeFileSync(ENV_PATH, out.join('\n'), 'utf8');

  for (const [key, value] of Object.entries(updates)) {
    if (value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function serialize(value) {
  const str = String(value);
  return /[\s#"']/.test(str) ? JSON.stringify(str) : str;
}

module.exports = { ENV_PATH, updateEnvFile };
