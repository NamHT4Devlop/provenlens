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

/**
 * A table name as SQL writes it: bare, quoted, or schema-qualified with each
 * part quoted on its own. `"public"."comments"` read by a pattern that
 * stopped at the closing quote named the schema and never the table.
 */
const NAME = `((?:["'\`]?\\w+["'\`]?\\.)*["'\`]?\\w+["'\`]?)`;
const TABLE_STATEMENTS = [
  new RegExp(`\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${NAME}`, 'gi'),
  new RegExp(`\\bALTER\\s+TABLE\\s+${NAME}`, 'gi'),
  new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${NAME}`, 'gi'),
  new RegExp(`\\bINSERT\\s+INTO\\s+${NAME}`, 'gi'),
  new RegExp(`\\bUPDATE\\s+${NAME}\\s+SET\\b`, 'gi'),
  new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+\\S+\\s+ON\\s+${NAME}`, 'gi'),
];

/** The unqualified, unquoted, lower-cased table out of a matched name. */
const tableOf = (name) => name.replace(/["'`]/g, '').split('.').pop().toLowerCase();

/** Table names a migration touches, lower-cased and unqualified. */
export function tablesIn(sql) {
  const found = new Set();
  const withoutComments = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const pattern of TABLE_STATEMENTS) {
    for (const [, name] of withoutComments.matchAll(pattern)) {
      found.add(tableOf(name));
    }
  }
  return [...found];
}

const REFERENCE_STATEMENTS = [
  new RegExp(`\\bFROM\\s+${NAME}`, 'gi'),
  new RegExp(`\\bJOIN\\s+${NAME}`, 'gi'),
  new RegExp(`\\bINSERT\\s+INTO\\s+${NAME}`, 'gi'),
  new RegExp(`\\bUPDATE\\s+${NAME}\\s+SET\\b`, 'gi'),
  new RegExp(`\\bDELETE\\s+FROM\\s+${NAME}`, 'gi'),
];

/** Tables a query reads or writes -- the other half of the migration link. */
export function tablesReferenced(sql) {
  const found = new Set();
  const withoutComments = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const pattern of REFERENCE_STATEMENTS) {
    for (const [, name] of withoutComments.matchAll(pattern)) {
      found.add(tableOf(name));
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
        ctx.emit({ role: 'provider', key: `table:${table}`, symbolId, fileId: file.id, line: 1, detail: table });
        if (!byTable.has(table)) byTable.set(table, []);
        byTable.get(table).push(symbolId);
      }
    }

    if (!byTable.size) return;

    // Consumers: types whose name matches the table by the usual convention,
    // plus MyBatis statements whose SQL names the table outright. Types are
    // indexed by name once: scanning all of them per table was tables x types,
    // ten seconds for two thousand tables over fifty thousand classes.
    const typesByName = new Map();
    for (const t of ctx.db
      .prepare(
        `SELECT s.id, s.name, s.file_id, s.start_line FROM symbols s
          WHERE s.kind IN ('class', 'interface')`,
      )
      .all()) {
      if (!typesByName.has(t.name)) typesByName.set(t.name, []);
      typesByName.get(t.name).push(t);
    }

    for (const [table] of byTable) {
      for (const name of classNamesFor(table)) {
        for (const t of typesByName.get(name) ?? []) {
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
    }

    for (const statement of ctx.db
      .prepare(
        `SELECT s.id, s.file_id, s.start_byte, s.end_byte, s.start_line, f.path
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
          line: statement.start_line,
          detail: table,
        });
      }
    }
  },
};
