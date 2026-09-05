/**
 * String bindings.
 *
 * Some frameworks connect two pieces of code by matching a string rather than
 * by one calling the other: a Camel route URI, an SQS queue name, a MyBatis
 * statement id. No call graph can see those links, so a plugin declares the two
 * ends and a generic pass joins them.
 *
 * A plugin exposes:
 *   name        identifier used in `via` and in stats
 *   accepts     (relPath) => boolean, for non-source files it needs to read
 *   collect     (ctx) => void, calling ctx.emit(...) for each endpoint
 *
 * An endpoint is { role: 'provider' | 'consumer', key, symbolId, fileId, line,
 * detail }. Providers are where the work happens; consumers point at them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkFiles } from '../project.js';
import mybatis from './mybatis.js';
import camel from './camel.js';
import sqs from './sqs.js';
import flyway from './flyway.js';
import http from './http.js';
import kafka from './kafka.js';
import springevent from './springevent.js';
import graphql from './graphql.js';
import grpc from './grpc.js';

export const PLUGINS = [mybatis, camel, sqs, flyway, http, kafka, springevent, graphql, grpc];

/**
 * Languages the binding plugins own. They have no grammar, so the normal
 * discovery pass never sees them; without this the indexer would count them as
 * deleted on every run and report a removal that did not happen.
 */
export const BINDING_LANGS = ['xml', 'sql', 'graphql', 'proto'];

export function runBindings(db, root) {
  db.exec("DELETE FROM edges WHERE via LIKE 'binding:%'");
  db.exec('DELETE FROM bindings');
  // Files a plugin owns are rebuilt from scratch each run, so a deleted XML
  // mapper cannot leave a stale statement behind.
  const langList = BINDING_LANGS.map((l) => `'${l}'`).join(', ');
  db.exec(`DELETE FROM files WHERE lang IN (${langList})`);

  const wanted = PLUGINS.filter((p) => p.accepts);
  const extraPaths = wanted.length
    ? walkFiles(root, (rel) => wanted.some((p) => p.accepts(rel)))
    : [];

  const insertFile = db.prepare(
    `INSERT INTO files (path, lang, hash, pkg, lines, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbols
       (file_id, name, fqn, kind, container_fqn, type_name, signature, arity, params,
        start_line, end_line, start_byte, end_byte, modifiers, annotations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBinding = db.prepare(
    `INSERT INTO bindings (file_id, symbol_id, plugin, role, key, line, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, kind, confidence, via, line)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const extraFiles = new Map(); // relPath -> { path, content, id }
  for (const rel of extraPaths) {
    let content;
    try {
      content = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const lang = rel.endsWith('.sql') ? 'sql' : /\.(graphqls?|gql)$/i.test(rel) ? 'graphql' : rel.endsWith('.proto') ? 'proto' : 'xml';
    const id = Number(
      insertFile.run(rel, lang, '', null, content.split('\n').length, Date.now()).lastInsertRowid,
    );
    extraFiles.set(rel, { path: rel, content, id });
  }

  const stats = {};

  for (const plugin of PLUGINS) {
    const emitted = [];

    const ctx = {
      db,
      root,
      files: [...extraFiles.values()].filter((f) => !plugin.accepts || plugin.accepts(f.path)),
      /** Call sites, optionally filtered, already parsed by the extractors. */
      refs(where = '') {
        return db
          .prepare(
            `SELECT r.*, f.path AS file_path, f.lang FROM refs r JOIN files f ON f.id = r.file_id
              ${where ? `WHERE ${where}` : ''}`,
          )
          .all()
          .map((r) => ({ ...r, strArgs: r.str_args ? JSON.parse(r.str_args) : [] }));
      },
      /** Raw text of an already-indexed source file, for regex-based plugins. */
      readSource(relPath) {
        return readFileSync(join(root, relPath), 'utf8');
      },
      addSymbol(spec) {
        return Number(
          insertSymbol.run(
            spec.fileId,
            spec.name,
            spec.fqn ?? spec.name,
            spec.kind,
            spec.containerFqn ?? null,
            null,
            spec.signature ?? spec.name,
            null,
            null,
            spec.startLine ?? 1,
            spec.endLine ?? spec.startLine ?? 1,
            spec.startByte ?? 0,
            spec.endByte ?? 0,
            JSON.stringify(spec.modifiers ?? ['generated']),
            JSON.stringify(spec.annotations ?? []),
          ).lastInsertRowid,
        );
      },
      emit(endpoint) {
        emitted.push(endpoint);
      },
    };

    try {
      plugin.collect(ctx);
    } catch (err) {
      process.stderr.write(`provenlens: binding plugin ${plugin.name} failed: ${err.message}\n`);
      continue;
    }

    for (const e of emitted) {
      insertBinding.run(
        e.fileId ?? null,
        e.symbolId ?? null,
        plugin.name,
        e.role,
        e.key,
        e.line ?? null,
        e.detail ?? null,
      );
    }

    // Join the two ends on the key. A consumer points at every provider of the
    // same key: more than one is normal (several routes feed one endpoint).
    const providers = new Map();
    for (const e of emitted) {
      if (e.role !== 'provider' || e.symbolId == null) continue;
      if (!providers.has(e.key)) providers.set(e.key, []);
      providers.get(e.key).push(e);
    }

    let wired = 0;
    for (const e of emitted) {
      if (e.role !== 'consumer' || e.symbolId == null) continue;
      for (const provider of providers.get(e.key) ?? []) {
        if (provider.symbolId === e.symbolId) continue;
        insertEdge.run(
          e.symbolId,
          provider.symbolId,
          plugin.edgeKind ?? 'binds',
          plugin.confidence ?? 0.9,
          `binding:${plugin.name}`,
          e.line ?? null,
        );
        wired++;
      }
    }

    const counts = { provider: 0, consumer: 0 };
    for (const e of emitted) counts[e.role] = (counts[e.role] ?? 0) + 1;
    if (emitted.length) stats[plugin.name] = { ...counts, wired };
  }

  return stats;
}
