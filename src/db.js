import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** Bump whenever the schema changes: the index is a cache, so it is rebuilt. */
export const SCHEMA_VERSION = 9;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
-- A watcher syncing in the background and an index run started by hand are
-- two writers on one file. Without a timeout the second one fails instantly
-- rather than waiting the moment the first needs, and takes its whole run
-- with it. Thirty seconds is far longer than any single statement here.
PRAGMA busy_timeout = 30000;

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
  indexed_at INTEGER,
  -- A declaration file from a dependency, read only so a chain can be typed
  -- through it. Its symbols are never resolution targets and never count
  -- towards coverage: they are not this project's code.
  external   INTEGER DEFAULT 0,
  -- Which dependency it came from, so a call landing there can name it.
  owner      TEXT
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
  -- The single generic argument of the declared type: Mono<User> -> User.
  -- A lambda over the value receives one of these, so erasing it here is what
  -- made every reactive chain untypable.
  type_args     TEXT,
  signature     TEXT,
  arity         INTEGER,
  -- JSON array of declared parameter type names, used to pick between overloads.
  params        TEXT,
  start_line    INTEGER,
  end_line      INTEGER,
  start_byte    INTEGER,
  end_byte      INTEGER,
  modifiers     TEXT,
  annotations   TEXT,
  -- JSON array of the raw supertype names this declaration wrote. Kept on the
  -- symbol so the types view can be rebuilt from every declaration of a
  -- name: a Ruby class reopened in a second file used to replace the first
  -- file's row and take its ancestors with it.
  supertypes    TEXT
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
  -- The single generic argument of the declared type: List<Post> -> Post. It
  -- is what a lambda over the value receives, so it cannot be thrown away.
  type_args       TEXT,
  -- For a lambda parameter, the call the lambda was passed to. The parameter's
  -- type is the element type of that call's receiver, known only at resolve
  -- time, so the link has to survive into the index.
  owner_ref_id    INTEGER,
  -- Set when the declaration was x = someCall(), so a resolver can come back
  -- and fill type_name in from the callee's declared return type.
  line            INTEGER,
  init_kind       TEXT,
  -- For init_kind = 'path', the initialiser as written: connection.manager.
  -- Nothing about that declares a type, but every segment of it does, and the
  -- resolver can walk them once the whole project is in the index.
  init_path       TEXT
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
  -- JSON array of string literal argument values, nulls for everything else.
  -- Frameworks wire themselves together with these: queue names, route URIs.
  str_args        TEXT,
  -- For a.b().c(), the ref for b() so the chain can be walked left to right.
  receiver_ref_id INTEGER,
  line            INTEGER,
  kind            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);

-- Resolved graph.
--
-- Both ends cascade. Without that, the edges of a symbol deleted on a sync
-- outlived it: they kept counting in status, kept a function off the dead
-- list after its last caller was removed, and -- once SQLite reused the id --
-- attached to a stranger. Three rebuilds of one repository tripled its edge
-- count without a single file changing.
CREATE TABLE IF NOT EXISTS edges (
  from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_symbol_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
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

-- Endpoints that frameworks connect by matching strings rather than by calls:
-- a Camel from()/to() URI, an SQS queue name, a MyBatis statement id. A plugin
-- emits providers and consumers; a generic pass joins them on the key column.
CREATE TABLE IF NOT EXISTS bindings (
  id        INTEGER PRIMARY KEY,
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  plugin    TEXT NOT NULL,
  role      TEXT NOT NULL,
  key       TEXT NOT NULL,
  line      INTEGER,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_bindings_key    ON bindings(plugin, key);
CREATE INDEX IF NOT EXISTS idx_bindings_symbol ON bindings(symbol_id);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name, fqn, signature, tokenize = 'unicode61'
);
`;

export function openDb(dbPath, { create = false } = {}) {
  // Owner-only, to match the token guarding the HTTP API: a world-readable
  // index would hand any other local user the very data that token protects.
  if (create) mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  // The pragma above only runs for a database being created; an existing one
  // is opened without re-reading the schema, and needs telling separately.
  db.exec('PRAGMA busy_timeout = 30000');
  if (create) {
    db.exec(SCHEMA);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
    // SQLite creates the file under the umask; tighten it and the sidecars.
    // The directory too: mkdirSync's mode only applies when it creates the
    // directory, and an index rebuilt in place keeps whatever mode it had.
    for (const suffix of ['', '-wal', '-shm']) {
      try { chmodSync(dbPath + suffix, 0o600); } catch { /* sidecar not there yet */ }
    }
    try { chmodSync(dirname(dbPath), 0o700); } catch { /* not ours to change */ }
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
