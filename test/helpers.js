import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { indexProject } from '../src/indexer.js';
import { searchSymbols } from '../src/query.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * One database per call, not one per fixture.
 *
 * `node --test` runs test files in parallel processes, and three of them build
 * the `java` fixture. Sharing a path meant one process deleting a database
 * another had open, mid-run: SQLITE_IOERR_FSTAT, a `disk I/O error` with no
 * hint of a second process in it. Linux happened to survive the race and macOS
 * did not, which is how a runner added for coverage found a real defect on its
 * first run.
 */
let dbSeq = 0;
const created = new Set();
process.on('exit', () => {
  for (const path of created) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
});

/** Indexes a fixture into a throwaway DB and returns handles for assertions. */
export async function buildIndex(fixture) {
  const root = join(HERE, '..', '__fixtures__', fixture);
  const slug = fixture.replace(/[^a-zA-Z0-9]+/g, '_') || 'root';
  const dbPath = join(HERE, '..', '__fixtures__', `.test-${slug}-${process.pid}-${dbSeq++}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  created.add(dbPath);

  const db = openDb(dbPath, { create: true });
  const stats = await indexProject(db, root, { full: true });

  const one = (query) => {
    const hits = searchSymbols(db, query, { limit: 5 });
    assert.ok(hits.length, `expected a match for "${query}"`);
    return hits[0];
  };

  const callsWhere = (external) =>
    db
      .prepare(
        `SELECT r.receiver, r.name FROM unresolved u JOIN refs r ON r.id = u.ref_id
          WHERE u.external = ?`,
      )
      .all(external)
      .map((r) => `${r.receiver ?? '(self)'}.${r.name}`)
      .sort();

  /** Call sites the resolver genuinely failed on -- these are the bugs. */
  const missedCalls = () => callsWhere(0);
  /** Call sites into a library, which are expected and not failures. */
  const externalCalls = () => callsWhere(1);
  const unresolvedCalls = () => [...missedCalls(), ...externalCalls()].sort();

  return { db, root, stats, one, missedCalls, externalCalls, unresolvedCalls };
}
