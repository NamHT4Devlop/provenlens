/**
 * The defects a full review found in the core, each pinned by the probe that
 * found it: edges that outlived their symbols, a test-file regex that read a
 * bank's `Deposit.java` as a test, build-output rules that hid tracked
 * source, a tie broken silently, a lock the background indexers never took,
 * and an `init` that bricked an older index.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { openDb, openProject, SCHEMA_VERSION } from '../src/db.js';
import { indexProject } from '../src/indexer.js';
import { isTestPath, bestMatch, ambiguityNote } from '../src/query.js';
import { discoverFiles, tryIndexLock, acquireIndexLock, dbPathFor } from '../src/project.js';
import { deadCode, hotspots } from '../src/insight.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'provenlens.js');

const tmp = () => mkdtempSync(join(tmpdir(), 'provenlens-core-'));
const write = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const gitInit = (root) => {
  execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
};
const count = (db, sql) => db.prepare(sql).get().n;

describe('edges die with their symbols', () => {
  test('a sync after a file is deleted leaves no edge from or to it', async () => {
    const root = tmp();
    const db = openDb(join(root, 'index.db'), { create: true });
    try {
      write(root, 'A.java', 'package p;\npublic class A {\n  void helper() { }\n  void other() { }\n}\n');
      write(root, 'B.java', 'package p;\npublic class B {\n  void run() { new A().helper(); }\n}\n');
      await indexProject(db, root, { full: true });
      assert.ok(count(db, 'SELECT COUNT(*) AS n FROM edges') > 0, 'the probe needs an edge to lose');

      rmSync(join(root, 'B.java'));
      await indexProject(db, root, { full: false });

      const orphans = count(
        db,
        `SELECT COUNT(*) AS n FROM edges e
          WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.from_symbol_id)
             OR NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.to_symbol_id)`,
      );
      assert.equal(orphans, 0, 'an edge of a deleted symbol must not survive it');

      // The consequence the probe saw: helper's last caller is gone, so it is
      // unreached now, and it was hidden by the dead edge.
      const dead = deadCode(db, root, { onlyCertain: false }).candidates.map((c) => c.fqn);
      assert.ok(dead.includes('p.A#helper'), `helper lost its only caller, got ${dead}`);
      assert.ok(!hotspots(db).some((h) => h.fqn === 'p.A#helper'), 'no caller means no hotspot');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rebuilding an unchanged tree does not grow the edge count', async () => {
    const root = tmp();
    const db = openDb(join(root, 'index.db'), { create: true });
    try {
      write(root, 'src/a.js', 'export function alpha() { return beta(); }\nexport function beta() { return 1; }\n');
      await indexProject(db, root, { full: true });
      const first = count(db, 'SELECT COUNT(*) AS n FROM edges');
      await indexProject(db, root, { full: true });
      await indexProject(db, root, { full: true });
      // express went 382 -> 764 -> 1146 -> 1528 this way, without a file changing.
      assert.equal(count(db, 'SELECT COUNT(*) AS n FROM edges'), first);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a Java class is a test by its suffix, read with the case it was written in', () => {
  test('production classes that happen to end in -it or -test are not tests', () => {
    for (const p of [
      'src/main/java/com/bank/Deposit.java',
      'src/main/java/com/bank/Credit.java',
      'src/main/java/com/shop/Commit.java',
      'src/main/java/com/x/Audit.java',
      'src/main/java/com/x/Unit.java',
      'src/main/java/com/x/Latest.java',
      'src/main/java/com/x/Contest.java',
    ]) {
      assert.equal(isTestPath(p), false, `${p} is production code`);
    }
  });

  test('the conventions themselves still count', () => {
    for (const p of [
      'src/test/java/com/x/AccountTest.java',
      'src/main/java/com/x/AccountTests.java',
      'src/main/java/com/x/AccountIT.java',
      'spec/models/user_spec.rb',
      'test/user_test.rb',
      'src/user.test.ts',
      'src/User.Spec.tsx',
    ]) {
      assert.equal(isTestPath(p), true, `${p} is a test`);
    }
  });
});

describe('what git tracks is source', { skip: !hasGit && 'git is not installed' }, () => {
  test('a tracked directory named like build output is indexed, and a nested .gitignore is read', () => {
    const root = tmp();
    try {
      gitInit(root);
      // spring-boot keeps 295 tracked files under a package called `build`;
      // next.js keeps its compiler under `src/build/`. Both were skipped by name.
      write(root, 'packages/next/src/build/index.js', 'export function compile() {}\n');
      // A package's own .gitignore, which only git used to read.
      write(root, 'sub/.gitignore', 'gen/\n');
      write(root, 'sub/gen/out.js', 'export function generated() {}\n');
      write(root, 'sub/src/real.js', 'export function real() {}\n');
      // A committed dependency tree is still a dependency tree.
      write(root, 'node_modules/dep/index.js', 'module.exports = {};\n');
      write(root, '.gitignore', '');
      const found = discoverFiles(root);
      assert.ok(found.includes('packages/next/src/build/index.js'), `tracked source under build/: ${found}`);
      assert.ok(found.includes('sub/src/real.js'));
      assert.ok(!found.includes('sub/gen/out.js'), `a nested .gitignore must be honoured: ${found}`);
      assert.ok(!found.some((f) => f.startsWith('node_modules/')), `a committed install is not source: ${found}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a file forced past the ignore rules is build output, not source', () => {
    const root = tmp();
    try {
      gitInit(root);
      write(root, '.gitignore', 'dist/\n');
      write(root, 'dist/index.js', 'export function built() {}\n');
      write(root, 'src/index.js', 'export function source() {}\n');
      execFileSync('git', ['-C', root, 'add', '-f', 'dist/index.js'], { stdio: 'ignore' });
      const found = discoverFiles(root);
      assert.deepEqual(found, ['src/index.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('without git the rules stand, and a nested .gitignore is still unread', () => {
    const root = tmp();
    try {
      write(root, 'src/build/index.js', 'export function compile() {}\n');
      write(root, 'src/app.js', 'export function app() {}\n');
      const found = discoverFiles(root);
      assert.deepEqual(found, ['src/app.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a file over the size cap is counted, not lost', () => {
  test('discovery reports it and the index counts it as unparsable', async () => {
    const root = tmp();
    const db = openDb(join(root, 'index.db'), { create: true });
    try {
      let big = '';
      for (let i = 0; big.length < 2_100_000; i++) big += `export function f${i}() { return ${i}; }\n`;
      write(root, 'src/big.js', big);
      write(root, 'src/small.js', 'export function small() { return 1; }\n');
      const oversized = [];
      discoverFiles(root, { oversized });
      assert.deepEqual(oversized, ['src/big.js']);
      const stats = await indexProject(db, root, { full: true });
      assert.equal(stats.unparsable, 1, 'the refused file must show in the count the CLI prints');
      assert.equal(stats.scanned, 2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a tie is reported, not broken', () => {
  test('bestMatch names every symbol sharing the top score', async () => {
    const root = tmp();
    const db = openDb(join(root, 'index.db'), { create: true });
    try {
      write(
        root,
        'src/a.js',
        'export class UserRepo { save(u) { return u; } }\nexport class OrderRepo { save(o) { return o; } }\nexport class Cache { save(k) { return k; } }\n',
      );
      await indexProject(db, root, { full: true });
      const { hit, ties } = bestMatch(db, 'save');
      assert.ok(hit);
      assert.equal(ties.length, 3);
      assert.match(ambiguityNote('save', ties), /Ambiguous "save" — 3 matches/);
      // Qualified, there is one answer and no tie.
      assert.equal(bestMatch(db, 'Cache#save').ties.length, 0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the CLI refuses to pick for the caller', async () => {
    const root = tmp();
    try {
      write(
        root,
        'src/a.js',
        'export class UserRepo { save(u) { return u; } }\nexport class Cache { save(k) { return k; } }\n',
      );
      const init = spawnSync(process.execPath, ['--no-warnings', BIN, 'init', root], { encoding: 'utf8' });
      assert.equal(init.status, 0, init.stderr);
      const res = spawnSync(process.execPath, ['--no-warnings', BIN, 'callers', 'save'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(res.status, 1, `expected a refusal, got:\n${res.stdout}`);
      assert.match(res.stderr, /Ambiguous "save"/);
      assert.match(res.stderr, /Cache#save/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the background indexers respect the lock', () => {
  test('tryIndexLock stands aside instead of throwing', () => {
    const root = tmp();
    try {
      mkdirSync(join(root, '.provenlens'));
      const release = acquireIndexLock(root);
      assert.equal(tryIndexLock(root), null, 'held elsewhere: null, not an error');
      release();
      const mine = tryIndexLock(root);
      assert.equal(typeof mine, 'function');
      mine();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('init on an index an older version built', () => {
  test('resets it instead of stamping the old tables with the new version', () => {
    const root = tmp();
    try {
      write(root, 'src/a.js', 'export function f() { return g(); }\nexport function g() { return 1; }\n');
      const first = spawnSync(process.execPath, ['--no-warnings', BIN, 'init', root], { encoding: 'utf8' });
      assert.equal(first.status, 0, first.stderr);

      // What an older provenlens left behind: one column short, one version back.
      const db = openDb(dbPathFor(root));
      db.exec('ALTER TABLE symbols DROP COLUMN supertypes');
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION - 1), 'schema_version');
      db.close();

      const again = spawnSync(process.execPath, ['--no-warnings', BIN, 'init', root], { encoding: 'utf8' });
      assert.equal(again.status, 0, `init must recover from an older index:\n${again.stderr}`);
      assert.match(again.stdout, /reset \(older schema\)/);
      assert.match(again.stdout, /indexed 1 file/);
      // And the index it leaves behind is the current shape.
      const { staleSchema } = openProject(dbPathFor(root));
      assert.equal(staleSchema, false);
      assert.ok(existsSync(dbPathFor(root)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('dead --public shows what its help text promises', () => {
  test('an exported function nothing calls is listed once asked for', async () => {
    const root = tmp();
    const db = openDb(join(root, 'index.db'), { create: true });
    try {
      write(root, 'src/a.js', 'export function useAll() { return 1; }\nfunction _helper() { return 2; }\n');
      await indexProject(db, root, { full: true });
      const certain = deadCode(db, root, { onlyCertain: true });
      assert.ok(!certain.candidates.some((c) => c.name === 'useAll'), 'held back by default');
      assert.equal(certain.publicHeldBack, 1);
      const all = deadCode(db, root, { onlyCertain: false });
      const names = all.candidates.map((c) => `${c.name}:${c.confidence}`);
      assert.ok(names.includes('useAll:medium'), `--public must show it, got ${names}`);
      assert.ok(names.includes('_helper:high'));
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
