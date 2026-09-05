import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, SCHEMA_VERSION } from '../src/db.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('schema', () => {
  test('the SQL literal contains no template syntax', () => {
    // The schema lives in a JS template literal, so a backtick inside a SQL
    // comment silently ends the string and breaks the module at import time.
    const source = readFileSync(join(HERE, '..', 'src', 'db.js'), 'utf8');
    const literal = /const SCHEMA = `([\s\S]*?)\n`;/.exec(source);
    assert.ok(literal, 'could not find the SCHEMA literal');

    const offenders = literal[1]
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => line.includes('`') || line.includes('${'));

    assert.deepEqual(
      offenders,
      [],
      `backtick or \${ inside the SQL: ${offenders.map(([n, l]) => `line ${n}: ${l}`).join(' | ')}`,
    );
  });

  test('every declared table is actually created', () => {
    const db = openDb(':memory:', { create: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);

    for (const expected of ['files', 'symbols', 'types', 'imports', 'locals', 'refs', 'edges', 'unresolved', 'bindings']) {
      assert.ok(tables.includes(expected), `missing table: ${expected}`);
    }
  });

  test('records the schema version it was built with', () => {
    const db = openDb(':memory:', { create: true });
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value;
    assert.equal(Number(version), SCHEMA_VERSION);
  });

  test('a fresh index is readable by its owner alone', () => {
    // The HTTP API is token-gated against other local users; a world-readable
    // index file would hand them the same data without asking the server.
    const root = mkdtempSync(join(tmpdir(), 'provenlens-perm-'));
    const dbPath = join(root, '.provenlens', 'index.db');
    const db = openDb(dbPath, { create: true });
    try {
      // A POSIX mode. Windows has no such bits -- it carries ACLs instead, and
      // Node reports a mode that means nothing there -- so the assertion is
      // made where it can be true. What it protects is stated in the README's
      // known limits rather than silently assumed everywhere.
      if (process.platform !== 'win32') {
        assert.equal(statSync(dirname(dbPath)).mode & 0o777, 0o700, '.provenlens/ must be 0700');
      }
      assert.equal(statSync(dbPath).mode & 0o777, 0o600, 'index.db must be 0600');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
