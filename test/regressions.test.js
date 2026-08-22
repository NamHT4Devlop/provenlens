import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from './helpers.js';
import { openDb } from '../src/db.js';
import { indexProject } from '../src/indexer.js';
import { searchSymbols, callersOf, affectedBy, isTestPath } from '../src/query.js';
import { buildIgnoreFilter } from '../src/project.js';

/** A throwaway project written from literals, for cases no fixture covers. */
async function tempProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'codelens-reg-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  const db = openDb(join(root, 'index.db'), { create: true });
  const stats = await indexProject(db, root, { full: true });
  return { db, root, stats, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('search', () => {
  let project;
  before(async () => {
    project = await tempProject({
      'a.rb': [
        'class Report',
        '  def total_given; 1; end',
        '  def totalXgiven; 2; end',
        '  def totalYgiven; 3; end',
        'end',
      ].join('\n'),
    });
  });

  test('treats underscore as a literal, not a LIKE wildcard', () => {
    // `_` means "any character" in LIKE, so an unescaped query matched every
    // totalXgiven in the project -- which is most names in a Ruby codebase.
    const hits = searchSymbols(project.db, 'total_given', { limit: 9 }).map((s) => s.name);
    assert.deepEqual(hits, ['total_given']);
  });

  test('treats percent as a literal too', () => {
    assert.deepEqual(searchSymbols(project.db, '%', { limit: 9 }), []);
  });

  test('returns nothing for an empty query instead of everything', () => {
    assert.deepEqual(searchSymbols(project.db, '', { limit: 9 }), []);
    assert.deepEqual(searchSymbols(project.db, '   ', { limit: 9 }), []);
  });

  test('orders results by score, best first', () => {
    const hits = searchSymbols(project.db, 'total', { limit: 9 });
    const scores = hits.map((h) => h.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });
});

describe('edge grouping', () => {
  test('counts one caller once no matter how often it calls', async () => {
    const project = await tempProject({
      'com/acme/Dup.java': [
        'package com.acme;',
        'public class Dup {',
        '  public int target() { return 1; }',
        '  public int caller() { return target() + target() + target(); }',
        '}',
      ].join('\n'),
    });

    const target = searchSymbols(project.db, 'Dup#target', { limit: 1 })[0];
    const callers = callersOf(project.db, target.id);
    assert.equal(callers.length, 1, 'three call sites are still one caller');
    assert.equal(callers[0].lines.length, 1, 'all three are on the same line here');
    project.cleanup();
  });
});

describe('incremental indexing', () => {
  test('reports no removals when nothing changed', async () => {
    // Binding plugins own the xml/sql rows. The discovery pass never sees them,
    // so it used to count them as deleted on every single sync.
    const { db, root, cleanup } = await tempProject({
      'src/main/java/com/shop/M.java': 'package com.shop;\npublic interface M { int f(); }\n',
      'src/main/resources/M.xml':
        '<mapper namespace="com.shop.M"><select id="f">SELECT 1 FROM t</select></mapper>',
    });

    const second = await indexProject(db, root, { full: false });
    assert.equal(second.removed, 0);
    assert.equal(second.parsed, 0);

    const third = await indexProject(db, root, { full: false });
    assert.equal(third.removed, 0);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM bindings').get().n > 0, 'bindings survive a sync');
    cleanup();
  });

  test('does notice a file that really was deleted', async () => {
    const { db, root, cleanup } = await tempProject({
      'a.rb': 'class A; end',
      'b.rb': 'class B; end',
    });
    rmSync(join(root, 'b.rb'));
    const after = await indexProject(db, root, { full: false });
    assert.equal(after.removed, 1);
    cleanup();
  });
});

describe('watcher ignore rules', () => {
  test('skips the directories discovery skips', () => {
    // The watcher used to test `rel.includes('/node_modules/')`, which misses
    // the top-level directory, so npm install triggered endless reindexing.
    const ignored = buildIgnoreFilter(process.cwd());
    for (const path of [
      'node_modules/react/index.js',
      'target/classes/X.java',
      'dist/bundle.js',
      '.codelens/index.db',
    ]) {
      assert.ok(ignored(path), `${path} should be ignored`);
    }
    assert.ok(!ignored('src/App.tsx'));
  });
});

describe('affected files', () => {
  let project;
  before(async () => {
    project = await tempProject({
      'src/Core.java': [
        'package app;',
        'public class Core {',
        '  public int value() { return 1; }',
        '}',
      ].join('\n'),
      'src/User.java': [
        'package app;',
        'public class User {',
        '  private Core core = new Core();',
        '  public int use() { return core.value(); }',
        '}',
      ].join('\n'),
      'test/CoreTest.java': [
        'package app;',
        'public class CoreTest {',
        '  private Core core = new Core();',
        '  public void checks() { core.value(); }',
        '}',
      ].join('\n'),
    });
  });

  test('recognises test files by path and by name', () => {
    assert.ok(isTestPath('test/CoreTest.java'));
    assert.ok(isTestPath('spec/models/donation_spec.rb'));
    assert.ok(isTestPath('src/__tests__/thing.ts'));
    assert.ok(isTestPath('src/thing.test.ts'));
    assert.ok(!isTestPath('src/latest/thing.ts'));
  });

  test('separates production callers from the tests that cover them', () => {
    const r = affectedBy(project.db, ['src/Core.java']);
    assert.ok(r.changed.some((s) => s.name === 'value'));
    assert.ok(
      r.reached.some((s) => s.fqn === 'app.User#use'),
      'the production caller must be reached',
    );
    assert.ok(
      r.tests.some((s) => s.fqn === 'app.CoreTest#checks'),
      'the test must be reported as coverage, not as a caller',
    );
    assert.ok(
      !r.reached.some((s) => s.file_path.startsWith('test/')),
      'tests must not be mixed into the reached list',
    );
  });

  test('reports paths it has never indexed rather than silently ignoring them', () => {
    const r = affectedBy(project.db, ['src/Core.java', 'src/NotHere.java']);
    assert.deepEqual(r.missingFiles, ['src/NotHere.java']);
  });
});

describe('robustness', () => {
  test('survives empty, unparseable and non-ASCII files', async () => {
    const { stats, db, cleanup } = await tempProject({
      'Empty.java': '',
      'Broken.java': 'package x;\npublic class Broken { void f( {\n',
      'Unicode.java': [
        'package x;',
        'public class Unicode {',
        '  // ghi chú tiếng Việt 🚀',
        '  private String tên = "xin chào";',
        '  public String lấyTên() { return tên; }',
        '  public String call() { return lấyTên(); }',
        '}',
      ].join('\n'),
    });

    assert.ok(stats.parsed >= 3);
    // Offsets are UTF-16 indices, so slicing source back out must survive emoji.
    const sym = searchSymbols(db, 'Unicode#lấyTên', { limit: 1 })[0];
    assert.ok(sym, 'a non-ASCII method name must still be findable');
    assert.equal(sym.name, 'lấyTên');
    cleanup();
  });
});
