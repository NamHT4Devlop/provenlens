/**
 * Flyway: a migration is the only place a column exists before any code uses
 * it, and nothing in the source refers to the migration by name. This turns
 * each migration into a symbol, works out which tables it touches, and links
 * it to the code that reads or writes those tables.
 *
 * The table-to-code link is by naming convention, so it carries a lower
 * confidence than a call the resolver actually saw.
 */
import { classify, singularize } from '../extract/ruby.js';

const MIGRATION = /(?:^|\/)(V[\d._]+__|R__|U[\d._]+__)([\w.-]+)\.sql$/i;

const TABLE_STATEMENTS = [
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([\w.]+)["'`]?/gi,
  /\bALTER\s+TABLE\s+["'`]?([\w.]+)["'`]?/gi,
  /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?([\w.]+)["'`]?/gi,
  /\bINSERT\s+INTO\s+["'`]?([\w.]+)["'`]?/gi,
  /\bUPDATE\s+["'`]?([\w.]+)["'`]?\s+SET\b/gi,
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+["'`]?([\w.]+)["'`]?/gi,
];

/** Table names a migration touches, lower-cased and unqualified. */
export function tablesIn(sql) {
  const found = new Set();
  const withoutComments = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const pattern of TABLE_STATEMENTS) {
    for (const [, name] of withoutComments.matchAll(pattern)) {
      found.add(name.split('.').pop().toLowerCase());
    }
  }
  return [...found];
}

const REFERENCE_STATEMENTS = [
  /\bFROM\s+["'`]?([\w.]+)["'`]?/gi,
  /\bJOIN\s+["'`]?([\w.]+)["'`]?/gi,
  /\bINSERT\s+INTO\s+["'`]?([\w.]+)["'`]?/gi,
  /\bUPDATE\s+["'`]?([\w.]+)["'`]?\s+SET\b/gi,
  /\bDELETE\s+FROM\s+["'`]?([\w.]+)["'`]?/gi,
];

/** Tables a query reads or writes -- the other half of the migration link. */
export function tablesReferenced(sql) {
  const found = new Set();
  const withoutComments = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const pattern of REFERENCE_STATEMENTS) {
    for (const [, name] of withoutComments.matchAll(pattern)) {
      found.add(name.split('.').pop().toLowerCase());
    }
  }
  return [...found];
}

/** `donations` -> the class names that plausibly map to it. */
function classNamesFor(table) {
  const singular = singularize(table);
  return new Set([classify(table), classify(singular), table, singular]);
}

export default {
  name: 'flyway',
  edgeKind: 'touches-table',
  confidence: 0.6,

  accepts: (rel) => MIGRATION.test(rel),

  collect(ctx) {
    const byTable = new Map(); // table -> [migration symbol ids]

    for (const file of ctx.files) {
      const match = MIGRATION.exec(file.path);
      const label = match ? `${match[1]}${match[2]}` : file.path.split('/').pop();
      const tables = tablesIn(file.content);

      const symbolId = ctx.addSymbol({
        fileId: file.id,
        name: label,
        fqn: file.path,
        kind: 'migration',
        signature: tables.length ? `migration touching ${tables.join(', ')}` : 'migration',
        startLine: 1,
        endLine: file.content.split('\n').length,
        startByte: 0,
        endByte: file.content.length,
        annotations: tables,
      });

      for (const table of tables) {
        ctx.emit({ role: 'provider', key: `table:${table}`, symbolId, fileId: file.id, detail: table });
        if (!byTable.has(table)) byTable.set(table, []);
        byTable.get(table).push(symbolId);
      }
    }

    if (!byTable.size) return;

    // Consumers: types whose name matches the table by the usual convention,
    // plus MyBatis statements whose SQL names the table outright.
    const types = ctx.db
      .prepare(
        `SELECT s.id, s.name, s.file_id, s.start_line FROM symbols s
          WHERE s.kind IN ('class', 'interface')`,
      )
      .all();

    for (const [table] of byTable) {
      const names = classNamesFor(table);
      for (const t of types) {
        if (!names.has(t.name)) continue;
        ctx.emit({
          role: 'consumer',
          key: `table:${table}`,
          symbolId: t.id,
          fileId: t.file_id,
          line: t.start_line,
          detail: table,
        });
      }
    }

    for (const statement of ctx.db
      .prepare(
        `SELECT s.id, s.file_id, s.start_byte, s.end_byte, f.path
           FROM symbols s JOIN files f ON f.id = s.file_id
          WHERE s.kind = 'sql-statement'`,
      )
      .all()) {
      let sql;
      try {
        sql = ctx.readSource(statement.path).slice(statement.start_byte, statement.end_byte);
      } catch {
        continue;
      }
      for (const table of tablesReferenced(sql)) {
        if (!byTable.has(table)) continue;
        ctx.emit({
          role: 'consumer',
          key: `table:${table}`,
          symbolId: statement.id,
          fileId: statement.file_id,
          detail: table,
        });
      }
    }
  },
};
