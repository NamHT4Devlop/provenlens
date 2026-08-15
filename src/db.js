import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Bump whenever the schema changes: the index is a cache, so it is rebuilt. */
export const SCHEMA_VERSION = 4;

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
  -- JSON array of declared parameter type names, used to pick between overloads.
  params        TEXT,
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
  is_static   INTEGER DEFAULT 0,
  -- orig: the name as the source module exports it, before any alias.
  -- kind: 'import' | 'reexport' | 'reexport-all'. The last two are what make
  -- barrel files resolvable.
  orig        TEXT,
  kind        TEXT DEFAULT 'import'
);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);

-- Variables and parameters, so a call receiver can be typed.
CREATE TABLE IF NOT EXISTS locals (
  id              INTEGER PRIMARY KEY,
  file_id         INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  scope_symbol_id INTEGER,
  name            TEXT,
  type_name       TEXT,
  -- Set when the declaration was x = someCall(), so a resolver can come back
  -- and fill type_name in from the callee's declared return type.
  line            INTEGER,
  init_kind       TEXT
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
  -- JSON array of raw argument expressions, typed later to pick an overload.
  arg_types       TEXT,
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

-- Call sites that produced no edge.
--
-- external = 1 means the target provably lives outside the indexed tree --
-- a JAR, a gem, node_modules -- with owner naming it where we can tell.
-- Those are not failures, and mixing them with real misses makes the coverage
-- number meaningless: in a typical Spring app most calls are library calls.
CREATE TABLE IF NOT EXISTS unresolved (
  ref_id   INTEGER PRIMARY KEY REFERENCES refs(id) ON DELETE CASCADE,
  reason   TEXT,
  external INTEGER DEFAULT 0,
  owner    TEXT
);
CREATE INDEX IF NOT EXISTS idx_unresolved_external ON unresolved(external);

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

/**
 * Opens a project index, recreating it when the schema has moved on.
 * `staleSchema` tells the caller the DB is now empty and needs a full reindex.
 */
export function openProject(dbPath) {
  if (!existsSync(dbPath)) {
    return { db: openDb(dbPath, { create: true }), staleSchema: true };
  }

  const db = openDb(dbPath);
  let version = null;
  try {
    version = getMeta(db, 'schema_version');
  } catch {
    version = null; // pre-versioning index
  }
  if (Number(version) === SCHEMA_VERSION) return { db, staleSchema: false };

  db.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  return { db: openDb(dbPath, { create: true }), staleSchema: true };
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}
