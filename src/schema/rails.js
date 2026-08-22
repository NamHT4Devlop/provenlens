/**
 * Rails schema awareness.
 *
 * An ActiveRecord model declares almost none of its own methods: `account.uri`
 * works because a `uri` column exists, and the only record of that in the
 * source is db/schema.rb. Without reading it, every attribute read looks like a
 * call into nothing, which is the single largest gap left in a Rails codebase.
 *
 * These methods are synthesised before resolution rather than in the binding
 * layer, because the resolvers need them to type receivers.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { camelize, singularize } from '../extract/ruby.js';

const SCHEMA_PATHS = ['db/schema.rb', 'db/structure.sql'];
const CREATE_TABLE = /create_table\s+["']([^"']+)["']([^\n]*)\sdo\s*\|(\w+)\|/g;
const COLUMN = /^\s*(\w+)\.(\w+)\s+["']([^"']+)["']/;

/**
 * @returns Map of table name -> { columns: string[], primaryKey: string|null }
 */
export function readRailsSchema(root) {
  const file = SCHEMA_PATHS.map((p) => join(root, p)).find((p) => existsSync(p));
  if (!file || !file.endsWith('.rb')) return new Map();

  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return new Map();
  }

  const tables = new Map();
  for (const match of source.matchAll(CREATE_TABLE)) {
    const [, table, options, blockVar] = match;
    const start = match.index + match[0].length;
    const end = source.indexOf('\n  end', start);
    const body = source.slice(start, end === -1 ? undefined : end);

    const columns = [];
    for (const line of body.split('\n')) {
      const col = COLUMN.exec(line);
      if (!col) continue;
      const [, receiver, kind, name] = col;
      // `t.index [...]` and `t.check_constraint` describe the table, not a column.
      if (receiver !== blockVar || kind === 'index' || kind === 'check_constraint') continue;
      columns.push(name);
    }

    // `id: false` means no implicit primary key.
    const hasId = !/\bid:\s*false\b/.test(options);
    tables.set(table, { columns, primaryKey: hasId ? 'id' : null });
  }
  return tables;
}

/**
 * Candidate model names for a table, best guess first.
 *
 * English pluralisation needs a table of irregulars to do properly -- statuses
 * comes from status, houses from house, and no rule separates them. Rather than
 * carry that table, every plausible form is offered and the caller keeps
 * whichever one names a class that actually exists in the index. The answer is
 * then read off the code instead of guessed.
 */
export function candidateModelsFor(table) {
  const forms = new Set([
    singularize(table),
    table.replace(/es$/, ''),
    table.replace(/s$/, ''),
    table,
  ]);
  // camelize, not classify: each form is already singular, and singularising
  // twice turns account_alias into AccountAlia.
  return [...forms].filter(Boolean).map(camelize);
}

/**
 * Attribute methods to add to each indexed model, keyed by class FQN.
 * Only classes that actually exist in the index get anything.
 */
export function railsAttributes(root, knownClassNames) {
  const tables = readRailsSchema(root);
  const perClass = new Map();

  for (const [table, { columns, primaryKey }] of tables) {
    const model = candidateModelsFor(table).find((name) => knownClassNames.has(name));
    if (!model) continue;

    const names = new Set(columns);
    if (primaryKey) names.add(primaryKey);

    perClass.set(model, {
      table,
      // A column gives a reader, a writer and a predicate.
      attributes: [...names].flatMap((c) => [c, `${c}=`, `${c}?`]),
    });
  }
  return perClass;
}
