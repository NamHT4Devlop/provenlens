import { readFileSync } from 'node:fs';

/** Above this a file is generated, not written, and can exhaust the WASM heap. */
const MAX_PARSE_BYTES = 2 * 1024 * 1024;
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getParser, langForPath } from './lang.js';
import { extractorFor } from './extract/index.js';
import { resolveJava } from './resolve/java.js';
import { resolveRuby } from './resolve/ruby.js';
import { resolveTypeScript } from './resolve/typescript.js';
import { discoverFiles } from './project.js';
import { runBindings, BINDING_LANGS } from './bindings/index.js';
import { railsAttributes } from './schema/rails.js';
import { setMeta, getMeta } from './db.js';
import { indexAmbient } from './ambient.js';
import { indexJvm } from './jvm.js';

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * One entry per resolver, not per language: the TS resolver handles .ts, .tsx
 * and .js together because they share a module graph.
 */
const RESOLVERS = [
  { name: 'java', langs: ['java'], fn: resolveJava },
  { name: 'ruby', langs: ['ruby'], fn: resolveRuby },
  { name: 'typescript', langs: ['typescript', 'tsx', 'javascript'], fn: resolveTypeScript },
];

/**
 * Parses every changed file into the DB, then rebuilds the graph.
 * `full: true` reparses everything even when hashes match.
 */
export async function indexProject(db, root, { full = false, onProgress } = {}) {
  const paths = discoverFiles(root);

  // Files owned by the binding plugins are rebuilt by them, not discovered
  // here, so they must stay out of the change/removal accounting.
  const bindingLangs = BINDING_LANGS.map(() => '?').join(', ');
  const existing = new Map();
  for (const row of db
    // External rows describe a dependency, not a file in this tree: they have
    // no path on disk and must not be mistaken for one that vanished.
    .prepare(
      `SELECT id, path, hash FROM files
        WHERE external = 0 AND lang NOT IN (${bindingLangs})`,
    )
    .all(...BINDING_LANGS)) {
    existing.set(row.path, row);
  }

  const stats = {
    scanned: paths.length,
    parsed: 0,
    skipped: 0,
    pending: 0,
    removed: 0,
    byLang: {},
    symbols: 0,
    // Files the parser could not take. Counted and reported rather than
    // silently dropped: a file that is not in the index is a file whose calls
    // are missing from the graph, and the number should say so.
    unparsable: 0,
  };

  const seen = new Set();

  const insertFile = db.prepare(
    `INSERT INTO files (path, lang, hash, pkg, lines, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       lang = excluded.lang, hash = excluded.hash, pkg = excluded.pkg,
       lines = excluded.lines, indexed_at = excluded.indexed_at`,
  );
  const deleteFileRows = db.prepare('DELETE FROM files WHERE path = ?');
  const insertSymbol = db.prepare(
    `INSERT INTO symbols
       (file_id, name, fqn, kind, container_fqn, type_name, type_args, signature, arity, params,
        start_line, end_line, start_byte, end_byte, modifiers, annotations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertType = db.prepare(
    'INSERT OR REPLACE INTO types (fqn, symbol_id, kind, supertypes) VALUES (?, ?, ?, ?)',
  );
  const insertImport = db.prepare(
    `INSERT INTO imports (file_id, fqn, simple, is_wildcard, is_static, orig, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLocal = db.prepare(
    `INSERT INTO locals (file_id, scope_symbol_id, name, type_name, type_args, owner_ref_id, line,
                         init_kind, init_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRef = db.prepare(
    `INSERT INTO refs (file_id, from_symbol_id, name, receiver, arity, arg_types, str_args,
                       receiver_ref_id, line, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    for (const rel of paths) {
      seen.add(rel);
      const lang = langForPath(rel);
      stats.byLang[lang] = (stats.byLang[lang] ?? 0) + 1;

      const extractor = extractorFor(lang);
      if (!extractor) {
        stats.pending++;
        continue;
      }

      let source;
      try {
        source = readFileSync(join(root, rel), 'utf8');
      } catch {
        continue;
      }
      const hash = sha1(source);

      if (!full && existing.get(rel)?.hash === hash) {
        stats.skipped++;
        continue;
      }

      // Cascades away the old symbols/refs/imports/locals for this file.
      deleteFileRows.run(rel);

      // tree-sitter runs in a WebAssembly heap of fixed size, and a generated
      // or minified file large enough to exhaust it aborts the runtime -- not
      // an exception this file could survive, but one that killed the whole
      // run and left no index at all. A cap is the only defence, and 2 MB is
      // far above any file written by hand.
      if (source.length > MAX_PARSE_BYTES) {
        stats.unparsable++;
        continue;
      }

      const parser = await getParser(lang);
      let result;
      try {
        result = extractor(parser.parse(source), source, { path: rel, lang });
      } catch {
        // One file the grammar cannot take is one file missing from the graph,
        // which is a far better outcome than no graph.
        stats.unparsable++;
        continue;
      }

      const fileId = Number(
        insertFile.run(
          rel,
          lang,
          hash,
          result.package ?? null,
          source.split('\n').length,
          Date.now(),
        ).lastInsertRowid,
      );

      for (const imp of result.imports) {
        insertImport.run(
          fileId,
          imp.fqn,
          imp.simple,
          imp.is_wildcard,
          imp.is_static,
          imp.orig ?? imp.simple,
          imp.kind ?? 'import',
        );
      }

      const tmpToReal = new Map();
      for (const s of result.symbols) {
        const id = Number(
          insertSymbol.run(
            fileId,
            s.name,
            s.fqn,
            s.kind,
            s.container_fqn,
            s.type_name,
            s.type_args ?? null,
            s.signature,
            s.arity,
            s.params ? JSON.stringify(s.params) : null,
            s.start_line,
            s.end_line,
            s.start_byte,
            s.end_byte,
            JSON.stringify(s.modifiers ?? []),
            JSON.stringify(s.annotations ?? []),
          ).lastInsertRowid,
        );
        tmpToReal.set(s.tmpId, id);
        // 'module' matters: a Ruby mixin is a real type for method lookup.
        if (['class', 'interface', 'enum', 'record', 'annotation', 'module'].includes(s.kind)) {
          insertType.run(s.fqn, id, s.kind, JSON.stringify(s.supertypes ?? []));
        }
        stats.symbols++;
      }

      // Refs are inserted in extraction order, and a chain link always points
      // at an earlier ref, so ids are known by the time they are needed.
      const refIds = new Array(result.refs.length).fill(null);
      result.refs.forEach((r, i) => {
        // An extractor that cannot name a call site has nothing to resolve.
        if (!r.name) return;
        refIds[i] = Number(
          insertRef.run(
            fileId,
            r.fromTmpId == null ? null : (tmpToReal.get(r.fromTmpId) ?? null),
            r.name,
            r.receiver,
            r.arity,
            r.arg_types ? JSON.stringify(r.arg_types) : null,
            r.str_args ? JSON.stringify(r.str_args) : null,
            r.receiverRefTmp == null ? null : refIds[r.receiverRefTmp],
            r.line,
            r.kind,
          ).lastInsertRowid,
        );
      });

      // After the refs, so a lambda parameter can name the call it belongs to.
      for (const l of result.locals) {
        insertLocal.run(
          fileId,
          tmpToReal.get(l.scopeTmpId) ?? null,
          l.name,
          l.type_name,
          l.type_args ?? null,
          l.ownerRefTmp == null ? null : refIds[l.ownerRefTmp],
          l.line ?? null,
          l.init_kind ?? null,
          l.init_path ?? null,
        );
      }

      stats.parsed++;
      onProgress?.(rel, stats);
    }

    // Files that disappeared from disk.
    for (const [path] of existing) {
      if (!seen.has(path)) {
        deleteFileRows.run(path);
        stats.removed++;
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Full-text index is small; rebuilding it beats keeping it in sync by hand.
  db.exec('BEGIN');
  db.exec('DELETE FROM symbols_fts');
  db.exec(
    `INSERT INTO symbols_fts (rowid, name, fqn, signature)
     SELECT id, name, COALESCE(fqn, ''), COALESCE(signature, '') FROM symbols`,
  );
  db.exec('COMMIT');

  // An ActiveRecord model declares almost none of its own methods: `account.uri`
  // works because a column exists, and db/schema.rb is the only record of that
  // in the source. Synthesised here so the resolvers can see them.
  const schemaStats = applyRailsSchema(db, root);

  // Declarations from the dependencies this project imports, read so a chain
  // can be typed THROUGH a library rather than stopping at one. They are
  // marked external: never a resolution target, never part of coverage.
  // Reading dependencies costs a second or two -- javap in particular -- and
  // nothing about them changes unless this project's imports do. A watch loop
  // reindexing on every keystroke must not pay it each time.
  const importFingerprint = createHash('sha1')
    .update(
      db
        .prepare(
          `SELECT i.fqn FROM imports i JOIN files f ON f.id = i.file_id
            WHERE f.external = 0 ORDER BY i.fqn`,
        )
        .all()
        .map((r) => r.fqn)
        .join('\n'),
    )
    .digest('hex');
  const alreadyRead =
    getMeta(db, 'ambient_fingerprint') === importFingerprint &&
    db.prepare('SELECT COUNT(*) AS n FROM files WHERE external = 1').get().n > 0;

  let ambientStats = { packages: 0, files: 0, symbols: 0, reused: alreadyRead };
  const needsAmbient = !alreadyRead && db
    .prepare("SELECT COUNT(*) AS n FROM files WHERE external = 0 AND lang IN ('typescript','tsx','javascript')")
    .get().n;
  if (needsAmbient > 0) {
    const parsers = new Map();
    for (const lang of ['typescript', 'tsx', 'javascript']) {
      try {
        parsers.set(lang, await getParser(lang));
      } catch {
        /* a grammar that will not load simply means no ambient types */
      }
    }
    ambientStats = indexAmbient(db, root, { parsers, extractorFor, langForPath });
  }

  // The same idea for Java, read with javap: a receiver typed by Mono<User> or
  // Optional<Post> has its type declared in a jar, and a chain stops there
  // without it. The JDK's own classes need no download at all, which turns a
  // pile of "assumed runtime" into proof.
  const hasJava = alreadyRead
    ? 0
    : db.prepare("SELECT COUNT(*) AS n FROM files WHERE external = 0 AND lang = 'java'").get().n;
  if (hasJava > 0) {
    try {
      const jvm = indexJvm(db, root);
      ambientStats = { ...ambientStats, jvmTypes: jvm.types, jvmMembers: jvm.members };
    } catch {
      // No javap on this machine simply means no signatures; everything else
      // about the index is unaffected.
    }
  }

  const resolveStats = {};
  for (const { name, langs, fn } of RESOLVERS) {
    const placeholders = langs.map(() => '?').join(', ');
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM files WHERE lang IN (${placeholders})`)
      .get(...langs).n;
    if (count > 0) resolveStats[name] = fn(db, root);
  }

  // Bindings run last: they join endpoints the call graph cannot see, and the
  // Flyway plugin reads statements the MyBatis plugin has just created.
  const bindingStats = runBindings(db, root);

  if (!alreadyRead) setMeta(db, 'ambient_fingerprint', importFingerprint);
  setMeta(db, 'last_indexed_at', Date.now());
  return {
    ...stats,
    resolve: resolveStats,
    bindings: bindingStats,
    schema: schemaStats,
    ambient: ambientStats,
  };
}

/**
 * Turns database columns into the attribute methods Rails would define.
 *
 * Marked `schema-column` so they are recognisable as derived, and rebuilt from
 * scratch each run so a dropped column cannot linger.
 */
function applyRailsSchema(db, root) {
  db.exec("DELETE FROM symbols WHERE modifiers LIKE '%schema-column%'");

  const classes = db
    .prepare(
      `SELECT s.id, s.name, s.fqn, s.file_id FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.lang = 'ruby' AND s.kind = 'class'`,
    )
    .all();
  if (!classes.length) return { tables: 0, attributes: 0 };

  const byName = new Map();
  for (const c of classes) if (!byName.has(c.name)) byName.set(c.name, c);

  const perClass = railsAttributes(root, new Set(byName.keys()));
  if (!perClass.size) return { tables: 0, attributes: 0 };

  const insert = db.prepare(
    `INSERT INTO symbols
       (file_id, name, fqn, kind, container_fqn, type_name, signature, arity, params,
        start_line, end_line, start_byte, end_byte, modifiers, annotations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let attributes = 0;
  db.exec('BEGIN');
  for (const [modelName, { table, attributes: names }] of perClass) {
    const model = byName.get(modelName);
    if (!model) continue;
    for (const attribute of names) {
      insert.run(
        model.file_id,
        attribute,
        `${model.fqn}#${attribute}`,
        'method',
        model.fqn,
        null,
        `${attribute}  # column on ${table}`,
        0,
        null,
        1,
        1,
        0,
        0,
        JSON.stringify(['generated', 'schema-column']),
        JSON.stringify([`column:${table}`]),
      );
      attributes++;
    }
  }
  db.exec('COMMIT');
  return { tables: perClass.size, attributes };
}
