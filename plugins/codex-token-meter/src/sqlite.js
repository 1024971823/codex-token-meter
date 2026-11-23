// Read-only SQLite access without a native addon: Node's built-in node:sqlite
// (Node >= 22.13 / Electron with Node 22) or, failing that, the optional sql.js
// (WebAssembly) package. Returns null when neither is available.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let backend;

async function loadBackend() {
  if (backend !== undefined) return backend;
  try {
    const process_ = globalThis.process;
    const emit = process_.emitWarning;
    process_.emitWarning = () => {}; // node:sqlite prints an ExperimentalWarning on first load
    try {
      const { DatabaseSync } = await import('node:sqlite');
      backend = { kind: 'node:sqlite', DatabaseSync };
    } finally {
      process_.emitWarning = emit;
    }
    return backend;
  } catch {}
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    backend = { kind: 'sql.js', SQL };
    return backend;
  } catch {}
  backend = null;
  return backend;
}

export async function sqliteBackend() {
  const b = await loadBackend();
  return b ? b.kind : null;
}

/** Opens `file` read-only; returns { all(sql), close() } or null when no SQLite backend is available. */
export async function openReadOnly(file) {
  const b = await loadBackend();
  if (!b) return null;
  if (b.kind === 'node:sqlite') {
    const db = new b.DatabaseSync(file, { readOnly: true });
    return { all: (sql) => db.prepare(sql).all(), close: () => db.close() };
  }
  const db = new b.SQL.Database(fs.readFileSync(file));
  return {
    all: (sql) => {
      const res = db.exec(sql);
      if (!res.length) return [];
      const { columns, values } = res[0];
      return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
    },
    close: () => db.close(),
  };
}
