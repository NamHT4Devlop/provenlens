import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex } from './helpers.js';

let db;
let calls;
let root;

before(async () => {
  const built = await buildIndex('vendored');
  db = built.db;
  root = built.root;
  calls = (fqnSuffix) => {
    const sym = built.one(fqnSuffix);
    return db
      .prepare(
        `SELECT s.fqn FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE e.from_symbol_id = ? AND e.kind = 'calls'`,
      )
      .all(sym.id)
      .map((r) => r.fqn);
  };
});

const paths = () =>
  db
    .prepare('SELECT path FROM files WHERE external = 0 ORDER BY path')
    .all()
    .map((r) => r.path);

describe('a repository that keeps its source inside node_modules', () => {
  test('indexes the directory its own .gitignore puts back', () => {
    // node-red keeps its entire product in `packages/node_modules` and says so
    // with `!packages/node_modules`. A blanket rule applied after that made 308
    // of its 541 JavaScript files invisible.
    assert.ok(
      paths().includes('packages/node_modules/@acme/engine/index.js'),
      `expected the vendored package to be project source, got ${paths()}`,
    );
  });

  test('the re-excluded file is on disk, so the test below can mean something', () => {
    // Committed with `git add -f`: this fixture's own .gitignore excludes it,
    // and git reads nested .gitignore files too. Without the force-add the
    // file would be absent in a fresh clone and the assertion below would pass
    // by having nothing to find.
    assert.ok(
      existsSync(
        join(root, 'packages', 'node_modules', '@acme', 'engine', 'generated', 'legacy.js'),
      ),
      'the re-excluded fixture file must exist for the next test to prove anything',
    );
  });

  test('still honours a re-exclusion inside that directory', () => {
    // `packages/node_modules/@acme/engine/generated` is excluded again on the
    // line after the negation, exactly as node-red excludes editor-client's
    // public tree. Putting a directory back does not put all of it back.
    assert.ok(
      !paths().some((p) => p.includes('/generated/')),
      'a path re-excluded after the negation must stay out',
    );
  });

  test('resolves a call into the vendored source, not to a dependency', () => {
    // The point of indexing it: the call now lands on a declaration.
    assert.ok(
      calls('start').some((fqn) => fqn.endsWith('Engine#ignite')),
      `expected start() to reach Engine#ignite, got ${calls('start')}`,
    );
  });
});
