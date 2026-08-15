import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getParser, langForPath } from './lang.js';
import { extractorFor } from './extract/index.js';
import { resolveJava } from './resolve/java.js';
import { resolveRuby } from './resolve/ruby.js';
import { resolveTypeScript } from './resolve/typescript.js';
import { discoverFiles } from './project.js';
import { setMeta } from './db.js';

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

  const existing = new Map();
  for (const row of db.prepare('SELECT id, path, hash FROM files').all()) {
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
       (file_id, name, fqn, kind, container_fqn, type_name, signature, arity, params,
        start_line, end_line, start_byte, end_byte, modifiers, annotations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertType = db.prepare(
    'INSERT OR REPLACE INTO types (fqn, symbol_id, kind, supertypes) VALUES (?, ?, ?, ?)',
  );
  const insertImport = db.prepare(
    `INSERT INTO imports (file_id, fqn, simple, is_wildcard, is_static, orig, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLocal = db.prepare(
    `INSERT INTO locals (file_id, scope_symbol_id, name, type_name, line, init_kind)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertRef = db.prepare(
    `INSERT INTO refs (file_id, from_symbol_id, name, receiver, arity, arg_types, line, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

      const parser = await getParser(lang);
      const tree = parser.parse(source);
      const result = extractor(tree, source, { path: rel, lang });

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
        if (['class', 'interface', 'enum', 'record', 'annotation'].includes(s.kind)) {
          insertType.run(s.fqn, id, s.kind, JSON.stringify(s.supertypes ?? []));
        }
        stats.symbols++;
      }

      for (const l of result.locals) {
        insertLocal.run(
          fileId,
          tmpToReal.get(l.scopeTmpId) ?? null,
          l.name,
          l.type_name,
          l.line ?? null,
          l.init_kind ?? null,
        );
      }
      for (const r of result.refs) {
        insertRef.run(
          fileId,
          r.fromTmpId == null ? null : (tmpToReal.get(r.fromTmpId) ?? null),
          r.name,
          r.receiver,
          r.arity,
          r.arg_types ? JSON.stringify(r.arg_types) : null,
          r.line,
          r.kind,
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

  const resolveStats = {};
  for (const { name, langs, fn } of RESOLVERS) {
    const placeholders = langs.map(() => '?').join(', ');
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM files WHERE lang IN (${placeholders})`)
      .get(...langs).n;
    if (count > 0) resolveStats[name] = fn(db, root);
  }

  setMeta(db, 'last_indexed_at', Date.now());
  return { ...stats, resolve: resolveStats };
}
