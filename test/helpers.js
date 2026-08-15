import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { indexProject } from '../src/indexer.js';
import { searchSymbols } from '../src/query.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Indexes a fixture into a throwaway DB and returns handles for assertions. */
export async function buildIndex(fixture) {
  const root = join(HERE, '..', '__fixtures__', fixture);
  const dbPath = join(HERE, '..', '__fixtures__', `.test-${fixture}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });

  const db = openDb(dbPath, { create: true });
  const stats = await indexProject(db, root, { full: true });

  const one = (query) => {
    const hits = searchSymbols(db, query, { limit: 5 });
    assert.ok(hits.length, `expected a match for "${query}"`);
    return hits[0];
  };

  const unresolvedCalls = () =>
    db
      .prepare('SELECT r.receiver, r.name FROM unresolved u JOIN refs r ON r.id = u.ref_id')
      .all()
      .map((r) => `${r.receiver ?? '(self)'}.${r.name}`)
      .sort();

  return { db, root, stats, one, unresolvedCalls };
}
