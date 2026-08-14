import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY,
  path       TEXT UNIQUE NOT NULL,
  lang       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  pkg        TEXT,
  lines      INTEGER,
  indexed_at INTEGER
);

-- One row per declared thing: type, method, constructor, field.
CREATE TABLE IF NOT EXISTS symbols (
  id            INTEGER PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  fqn           TEXT,
  kind          TEXT NOT NULL,
  container_fqn TEXT,
  type_name     TEXT,
  signature     TEXT,
  arity         INTEGER,
  start_line    INTEGER,
  end_line      INTEGER,
  start_byte    INTEGER,
  end_byte      INTEGER,
  modifiers     TEXT,
  annotations   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sym_name      ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_sym_fqn       ON symbols(fqn);
CREATE INDEX IF NOT EXISTS idx_sym_container ON symbols(container_fqn);
CREATE INDEX IF NOT EXISTS idx_sym_file      ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_sym_kind      ON symbols(kind);

-- Type-level view used by the resolver: supertypes are raw (unresolved) names.
CREATE TABLE IF NOT EXISTS types (
  fqn        TEXT PRIMARY KEY,
  symbol_id  INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  kind       TEXT,
  supertypes TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  fqn         TEXT NOT NULL,
  simple      TEXT,
  is_wildcard INTEGER DEFAULT 0,
  is_static   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);

-- Variables and parameters, so a call receiver can be typed.
CREATE TABLE IF NOT EXISTS locals (
  id              INTEGER PRIMARY KEY,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  scope_symbol_id INTEGER,
  name            TEXT,
  type_name       TEXT
);
CREATE INDEX IF NOT EXISTS idx_locals_scope ON locals(scope_symbol_id);

-- Raw call sites, before resolution.
CREATE TABLE IF NOT EXISTS refs (
  id              INTEGER PRIMARY KEY,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  from_symbol_id  INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  receiver        TEXT,
  arity           INTEGER,
  line            INTEGER,
  kind            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);

-- Resolved graph.
CREATE TABLE IF NOT EXISTS edges (
  from_symbol_id INTEGER NOT NULL,
  to_symbol_id   INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  confidence     REAL DEFAULT 1.0,
  via            TEXT,
  line           INTEGER,
  PRIMARY KEY (from_symbol_id, to_symbol_id, kind, line)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_symbol_id);

-- Call sites the resolver could not pin down; kept for honest coverage stats.
CREATE TABLE IF NOT EXISTS unresolved (
  ref_id  INTEGER PRIMARY KEY REFERENCES refs(id) ON DELETE CASCADE,
  reason  TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, fqn, signature, tokenize = 'unicode61'
);
`;

export function openDb(dbPath, { create = false } = {}) {
  if (create) mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (create) {
    db.exec(SCHEMA);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  }
  return db;
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}
