import { test, before, after, describe } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep, resolve } from 'node:path';
import { buildIndex } from './helpers.js';
import { openDb } from '../src/db.js';
import { indexProject } from '../src/indexer.js';
import { searchSymbols, callersOf, affectedBy, isTestPath } from '../src/query.js';
import { buildIgnoreFilter, dbPathFor, repoRelative } from '../src/project.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A throwaway project written from literals, for cases no fixture covers. */
async function tempProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'provenlens-reg-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  const db = openDb(join(root, 'index.db'), { create: true });
  const stats = await indexProject(db, root, { full: true });
  return {
    db,
    root,
    stats,
    // Windows will not delete a file another handle still holds open, so the
    // database has to be closed before the directory goes. On POSIX the
    // difference never shows, which is why 41 tests only failed once a Windows
    // runner was asked.
    cleanup: () => {
      try { db.close(); } catch { /* already closed by the test */ }
      rmSync(root, { recursive: true, force: true });
    },
  };
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
    // the top-level directory, so installing dependencies triggered endless
    // reindexing.
    const ignored = buildIgnoreFilter(process.cwd());
    for (const path of [
      'node_modules/react/index.js',
      'target/classes/X.java',
      'dist/bundle.js',
      '.provenlens/index.db',
    ]) {
      assert.ok(ignored(path), `${path} should be ignored`);
    }
    assert.ok(!ignored('src/App.tsx'));
  });
});

describe('a path the way the index spells it', () => {
  // The CLI and the MCP server both tested `abs.startsWith(root + '/')`, which
  // is never true on Windows, where the separator is `\\`. Every absolute path
  // there fell through unchanged and matched nothing in the index.
  const root = resolve('some', 'repo');

  test('turns an absolute path under the root into the relative, slash-separated form', () => {
    assert.equal(repoRelative(root, join(root, 'src', 'a.ts')), 'src/a.ts');
  });

  test('accepts the native separator on the way in and never emits it', () => {
    assert.equal(repoRelative(root, [root, 'src', 'deep', 'b.rb'].join(sep)), 'src/deep/b.rb');
  });

  test('refuses a path outside the root rather than guessing', () => {
    assert.equal(repoRelative(root, resolve('some', 'other', 'c.js')), null);
    assert.equal(repoRelative(root, join(root, '..', 'escape.js')), null);
    assert.equal(repoRelative(root, root), null);
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

describe('externality evidence', () => {
  test('proves a call external when nothing in the index declares that name', async () => {
    const { db, cleanup } = await tempProject({
      'App.java': [
        'package app;',
        'import java.util.List;',
        'public class App {',
        '  private List<String> items;',
        '  public int run() { return items.size(); }',
        '  public String odd() { return thisNameExistsNowhere(); }',
        '}',
      ].join('\n'),
    });

    const rows = db
      .prepare(
        `SELECT r.name, u.reason, u.external FROM unresolved u JOIN refs r ON r.id = u.ref_id
          WHERE r.name = 'thisNameExistsNowhere'`,
      )
      .all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].external, 1, 'a name declared nowhere cannot target this project');
    assert.equal(rows[0].reason, 'external:not-in-project');
    cleanup();
  });

  test('does not claim a call is external when the name does exist here', async () => {
    const { db, cleanup } = await tempProject({
      'Helper.java': [
        'package app;',
        'public class Helper {',
        '  public String describe() { return "x"; }',
        '}',
      ].join('\n'),
      'App.java': [
        'package app;',
        'public class App {',
        '  private App other;',
        '  public String use() { return other.describe(); }',
        '}',
      ].join('\n'),
    });

    // `other` is an App, which has no describe() -- but Helper declares one, so
    // calling this external would be a guess rather than a proof.
    const row = db
      .prepare(
        `SELECT u.external FROM unresolved u JOIN refs r ON r.id = u.ref_id
          WHERE r.name = 'describe'`,
      )
      .get();
    assert.ok(row, 'expected the call to be recorded');
    assert.equal(row.external, 0, 'a name declared here must stay a miss, not a proof');
    cleanup();
  });

  test('prefers the proof over the assumption when both could apply', async () => {
    const { db, cleanup } = await tempProject({
      'a.js': ['export function f(xs) {', '  return xs.reduceRight((x) => x);', '}'].join('\n'),
    });

    // Nothing here declares reduceRight, so it is proven external rather than
    // merely assumed to be an Array method.
    const row = db
      .prepare(
        `SELECT u.reason FROM unresolved u JOIN refs r ON r.id = u.ref_id
          WHERE r.name = 'reduceRight'`,
      )
      .get();
    assert.equal(row.reason, 'external:not-in-project');
    cleanup();
  });

  test('falls back to the runtime label only when the name also exists here', async () => {
    const { db, cleanup } = await tempProject({
      'coll.ts': ['export class Coll {', '  map(): number { return 1; }', '}'].join('\n'),
      'use.js': ['export function f(xs) {', '  return xs.map((x) => x);', '}'].join('\n'),
    });

    // Coll declares map, so the proof no longer applies; an untyped receiver
    // calling .map is assumed to be an Array, under its own owner.
    const row = db
      .prepare(
        `SELECT u.owner, u.reason FROM unresolved u JOIN refs r ON r.id = u.ref_id
          JOIN files fl ON fl.id = r.file_id WHERE r.name = 'map' AND fl.path = 'use.js'`,
      )
      .get();
    assert.equal(row.owner, 'js-runtime');
    cleanup();
  });

  test('a project method is never shadowed by the built-in list', async () => {
    const { db, cleanup } = await tempProject({
      'box.ts': [
        'export class Box {',
        '  get(): number { return 1; }',
        '}',
        'const b = new Box();',
        'export const v = b.get();',
      ].join('\n'),
    });

    // `get` is in the runtime list, but the receiver's type is known here.
    const edge = db
      .prepare(
        `SELECT s.name FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE e.kind = 'calls' AND s.name = 'get'`,
      )
      .get();
    assert.ok(edge, 'a typed receiver must resolve to the project method');
    cleanup();
  });

  test('carries externality along a chain', async () => {
    const { db, cleanup } = await tempProject({
      'App.java': [
        'package app;',
        'import com.vendor.Client;',
        'public class App {',
        '  private Client client;',
        '  public int go() { return client.fetch().reduceIt(); }',
        '}',
      ].join('\n'),
    });

    // fetch() is on a vendor type, so whatever it returned is vendor too.
    const row = db
      .prepare(
        `SELECT u.external FROM unresolved u JOIN refs r ON r.id = u.ref_id
          WHERE r.name = 'reduceIt'`,
      )
      .get();
    assert.equal(row.external, 1);
    cleanup();
  });
});

describe('scope modelling', () => {
  test('an inner class can see the enclosing class fields', async () => {
    // JUnit 5 @Nested classes declare their mocks on the outer class, so
    // without this every such receiver looks untyped.
    const { db, cleanup } = await tempProject({
      'Svc.java': [
        'package app;',
        'public class Svc {',
        '  public int work() { return 1; }',
        '}',
      ].join('\n'),
      'SvcTest.java': [
        'package app;',
        'public class SvcTest {',
        '  Svc svc;',
        '  class Inner {',
        '    int run() { return svc.work(); }',
        '  }',
        '}',
      ].join('\n'),
    });

    const edge = db
      .prepare(
        `SELECT sf.fqn AS f FROM edges e
           JOIN symbols sf ON sf.id = e.from_symbol_id
           JOIN symbols st ON st.id = e.to_symbol_id
          WHERE st.fqn = 'app.Svc#work' AND e.kind = 'calls'`,
      )
      .get();
    assert.ok(edge, 'the inner class must reach the outer field');
    assert.equal(edge.f, 'app.SvcTest.Inner#run');
    cleanup();
  });

  test('a bare call cannot reach an unrelated class method', async () => {
    const { db, cleanup } = await tempProject({
      'a.rb': ['class Alpha', '  def shared_helper; 1; end', 'end'].join('\n'),
      'b.rb': ['class Beta', '  def go', '    shared_helper', '  end', 'end'].join('\n'),
    });

    // Beta does not inherit from Alpha, so `shared_helper` is not in scope.
    // Linking it anyway is what the old global name match did.
    const edge = db
      .prepare(
        `SELECT COUNT(*) n FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE s.fqn = 'Alpha#shared_helper' AND e.kind = 'calls'`,
      )
      .get();
    assert.equal(edge.n, 0, 'an out-of-scope name must not become an edge');
    cleanup();
  });

  test('but a bare call does reach an inherited method', async () => {
    const { db, cleanup } = await tempProject({
      'base.rb': ['class Base', '  def shared_helper; 1; end', 'end'].join('\n'),
      'child.rb': ['class Child < Base', '  def go', '    shared_helper', '  end', 'end'].join('\n'),
    });

    const edge = db
      .prepare(
        `SELECT COUNT(*) n FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE s.fqn = 'Base#shared_helper' AND e.kind = 'calls'`,
      )
      .get();
    assert.equal(edge.n, 1, 'the ancestor chain is in scope and must resolve');
    cleanup();
  });

  test('types a Java var from what the call returns', async () => {
    const { db, cleanup } = await tempProject({
      'App.java': [
        'package app;',
        'public class App {',
        '  public Helper make() { return new Helper(); }',
        '  public int use() {',
        '    var helper = make();',
        '    return helper.value();',
        '  }',
        '}',
      ].join('\n'),
      'Helper.java': [
        'package app;',
        'public class Helper {',
        '  public int value() { return 1; }',
        '}',
      ].join('\n'),
    });

    const edge = db
      .prepare(
        `SELECT e.confidence FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE s.fqn = 'app.Helper#value' AND e.kind = 'calls'`,
      )
      .get();
    assert.ok(edge, 'var must take the declared return type of make()');
    assert.equal(edge.confidence, 1, 'a declared return type is not a guess');
    cleanup();
  });
});

describe('bindings the resolver must not miss', () => {
  test('a catch parameter is typed, so it cannot capture the wrong method', async () => {
    // Without the binding, `e` was untyped and the name fallback attached
    // e.getMessage() to the enclosing class's own getMessage.
    const { db, cleanup } = await tempProject({
      'A.java': [
        'package p;',
        'import java.io.IOException;',
        'public class A {',
        '  public String getMessage() { return "own"; }',
        '  public void go() {',
        '    try { work(); } catch (IOException e) { System.out.println(e.getMessage()); }',
        '  }',
        '  void work() {}',
        '}',
      ].join('\n'),
    });

    const wrong = db
      .prepare(
        `SELECT COUNT(*) n FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE s.fqn = 'p.A#getMessage' AND e.kind = 'calls'`,
      )
      .get();
    assert.equal(wrong.n, 0, 'the exception must not be mistaken for the class');

    const row = db
      .prepare(
        `SELECT u.owner FROM unresolved u JOIN refs r ON r.id = u.ref_id
          WHERE r.name = 'getMessage'`,
      )
      .get();
    assert.equal(row.owner, 'java.io.IOException');
    cleanup();
  });

  test('a try-with-resources variable is typed', async () => {
    const { db, cleanup } = await tempProject({
      'B.java': [
        'package p;',
        'public class B {',
        '  Helper open() { return new Helper(); }',
        '  void go() { try (Helper h = open()) { h.use(); } catch (Exception e) {} }',
        '}',
      ].join('\n'),
      'Helper.java': ['package p;', 'public class Helper {', '  public void use() {}', '}'].join('\n'),
    });

    const edge = db
      .prepare(
        `SELECT e.confidence FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE s.fqn = 'p.Helper#use'`,
      )
      .get();
    assert.ok(edge && edge.confidence === 1);
    cleanup();
  });

  test('a module-level constant is visible inside the functions that use it', async () => {
    const { db, cleanup } = await tempProject({
      'svc.ts': ['export class Svc {', '  run(): number { return 1; }', '}'].join('\n'),
      'use.ts': [
        "import { Svc } from './svc';",
        'const svc = new Svc();',
        'export function go(): number {',
        '  return svc.run();',
        '}',
      ].join('\n'),
    });

    const edge = db
      .prepare(
        `SELECT e.confidence FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE s.fqn = 'svc:Svc#run'`,
      )
      .get();
    assert.ok(edge, 'a function must see the module scope around it');
    assert.equal(edge.confidence, 1);
    cleanup();
  });

  test('an identifier the module neither declares nor imports is ambient', async () => {
    const { db, cleanup } = await tempProject({
      'thing.ts': ['export class Thing {', '  log(): void {}', '}'].join('\n'),
      'use.ts': ['export function go(): void {', '  console.log("hi");', '}'].join('\n'),
    });

    // ES modules cannot reach another module's exports without importing them,
    // so `console` can only be a host global -- never the project's Thing#log.
    const wrong = db
      .prepare(
        `SELECT COUNT(*) n FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE s.fqn = 'thing:Thing#log'`,
      )
      .get();
    assert.equal(wrong.n, 0);

    const row = db
      .prepare(
        `SELECT u.owner FROM unresolved u JOIN refs r ON r.id = u.ref_id WHERE r.name = 'log'`,
      )
      .get();
    assert.equal(row.owner, 'ambient-global');
    cleanup();
  });

  test('types an RSpec let and subject from the class they construct', async () => {
    const { db, cleanup } = await tempProject({
      'app/account.rb': ['class Account', '  def suspend!; true; end', 'end'].join('\n'),
      'spec/account_spec.rb': [
        'RSpec.describe Account do',
        '  let(:account) { Account.new }',
        '  subject { Account.new }',
        "  it 'suspends' do",
        '    account.suspend!',
        '  end',
        'end',
      ].join('\n'),
    });

    const edge = db
      .prepare(
        `SELECT e.confidence FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE s.fqn = 'Account#suspend!'`,
      )
      .get();
    assert.ok(edge, 'a spec must link to the code it exercises');
    assert.equal(edge.confidence, 1);

    const bound = db
      .prepare("SELECT name, type_name FROM locals WHERE name IN ('account','subject','described_class') ORDER BY name")
      .all();
    assert.deepEqual(
      bound.map((b) => `${b.name}:${b.type_name}`),
      ['account:Account', 'described_class:Account', 'subject:Account'],
    );
    cleanup();
  });
});

describe('rails schema', () => {
  test('turns database columns into the attribute methods Rails defines', async () => {
    const { db, cleanup } = await tempProject({
      'db/schema.rb': [
        'ActiveRecord::Schema[7.1].define(version: 1) do',
        '  create_table "organizations", force: :cascade do |t|',
        '    t.string "name", null: false',
        '    t.string "intake_location"',
        '    t.index ["name"], name: "idx_org_name"',
        '  end',
        'end',
      ].join('\n'),
      'app/models/organization.rb': ['class Organization', 'end'].join('\n'),
      'app/controllers/orgs_controller.rb': [
        'class OrgsController',
        '  def show',
        '    org = Organization.new',
        '    org.intake_location',
        '  end',
        'end',
      ].join('\n'),
    });

    // The column is the only record of intake_location anywhere in the source.
    const edge = db
      .prepare(
        `SELECT s.signature FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
          WHERE s.fqn = 'Organization#intake_location'`,
      )
      .get();
    assert.ok(edge, 'a column read must reach the attribute it comes from');
    assert.match(edge.signature, /column on organizations/);

    // t.index describes the table, not a column.
    const indexAttr = db.prepare("SELECT COUNT(*) n FROM symbols WHERE name = 'index'").get();
    assert.equal(indexAttr.n, 0);
    cleanup();
  });

  test('picks the model name the codebase actually uses', async () => {
    const { db, cleanup } = await tempProject({
      'db/schema.rb': [
        'ActiveRecord::Schema[7.1].define(version: 1) do',
        '  create_table "statuses", force: :cascade do |t|',
        '    t.string "uri"',
        '  end',
        'end',
      ].join('\n'),
      'app/models/status.rb': ['class Status', 'end'].join('\n'),
    });

    // No rule turns `statuses` into `status` without a table of irregulars, so
    // the candidates are checked against the classes that exist.
    const attr = db.prepare("SELECT COUNT(*) n FROM symbols WHERE fqn = 'Status#uri'").get();
    assert.equal(attr.n, 1);
    cleanup();
  });
});

describe('affected --fail-if-untested', () => {
  // The CI gate: exit 2 when a production change is reached by no test.
  const CLI = join(HERE, '..', 'bin', 'provenlens.js');
  let covered;
  let bare;

  const run = (cwd, args) =>
    new Promise((done) => {
      const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { cwd });
      let out = '';
      let errOut = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (errOut += c));
      child.on('close', (code) => done({ code, out, errOut }));
    });

  before(async () => {
    covered = mkdtempSync(join(tmpdir(), 'provenlens-gate-a-'));
    bare = mkdtempSync(join(tmpdir(), 'provenlens-gate-b-'));
    const price = [
      'package shop;',
      'public class Price {',
      '  public int total(int cents) { return cents * 2; }',
      '}',
    ].join('\n');
    const spec = [
      'package shop;',
      'public class PriceTest {',
      '  public void checks() { new Price().total(3); }',
      '}',
    ].join('\n');
    for (const root of [covered, bare]) {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'Price.java'), price);
    }
    mkdirSync(join(covered, 'test'), { recursive: true });
    writeFileSync(join(covered, 'test', 'PriceTest.java'), spec);
    for (const root of [covered, bare]) {
      const db = openDb(dbPathFor(root), { create: true });
      await indexProject(db, root, { full: true });
      db.close();
    }
  });

  after(() => {
    rmSync(covered, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });

  test('passes when an existing test reaches the changed code', async () => {
    const r = await run(covered, ['affected', 'src/Price.java', '--fail-if-untested']);
    assert.equal(r.code, 0, r.errOut);
  });

  test('fails with exit 2 when nothing tests the change', async () => {
    const r = await run(bare, ['affected', 'src/Price.java', '--fail-if-untested']);
    assert.equal(r.code, 2);
    assert.match(r.errOut, /no test reaches/);
  });

  test('reads a repo-relative path from a subdirectory, the way git prints one', async () => {
    // `git diff --name-only | provenlens affected` is the documented use, and
    // git prints paths relative to the repository root wherever it is run.
    // Resolving them against the working directory doubled the path from any
    // subdirectory -- `src/Price.java` became `src/src/Price.java` -- and
    // reported a file that was in the index as missing from it.
    const r = await run(join(covered, 'src'), ['affected', 'src/Price.java', '--json']);
    assert.equal(r.code, 0, r.errOut);
    const parsed = JSON.parse(r.out);
    assert.deepEqual(parsed.missingFiles, []);
    assert.ok(parsed.changed.some((s) => s.name === 'total'), 'the changed method must be found');
  });

  test('still accepts a path relative to the working directory', async () => {
    const r = await run(join(covered, 'src'), ['affected', 'Price.java', '--json']);
    assert.equal(r.code, 0, r.errOut);
    assert.deepEqual(JSON.parse(r.out).missingFiles, []);
  });

  test('a diff that only touches tests passes by definition', async () => {
    const r = await run(covered, ['affected', 'test/PriceTest.java', '--fail-if-untested']);
    assert.equal(r.code, 0, r.errOut);
  });

  test('--json reports the same verdict without exiting differently', async () => {
    const r = await run(bare, ['affected', 'src/Price.java', '--fail-if-untested', '--json']);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).untested, true);
  });
});

describe('mermaid export', () => {
  test('serializes a graph with quoted labels and typed shapes', async () => {
    const { db, one } = await buildIndex('java');
    const { graphAround } = await import('../src/query.js');
    const { toMermaid } = await import('../src/format.js');
    const text = toMermaid(graphAround(db, one('com.acme.service.DonationService').id, { depth: 1 }));

    assert.match(text, /^flowchart LR/);
    // A type gets the stadium shape, a member the rectangle.
    assert.match(text, /\(\["com\.acme\.service\.DonationService"\]\)/);
    assert.match(text, /\["com\.acme\.service\.DonationService#record"\]/);
    // Non-call edges carry their kind as the edge label.
    assert.match(text, /-- implements -->/);
    // Every node referenced by an edge is declared.
    for (const m of text.matchAll(/n(\d+) (?:--.*)?-+> n(\d+)/g)) {
      assert.match(text, new RegExp(`  n${m[1]}[\\[({]`), `undeclared node n${m[1]}`);
      assert.match(text, new RegExp(`  n${m[2]}[\\[({]`), `undeclared node n${m[2]}`);
    }
  });

  test('escapes double quotes so a hostile name cannot break the diagram', async () => {
    const { toMermaid } = await import('../src/format.js');
    const text = toMermaid({
      nodes: [{ id: 1, fqn: 'evil"] --> pwn["x', kind: 'class', derived: false }],
      edges: [],
      truncated: false,
    });
    assert.ok(!text.includes('evil"]'), 'quote must be neutralised');
    assert.match(text, /#quot;/);
  });
});

describe('pathBetween', () => {
  test('finds the chain through two interface layers', async () => {
    const { db, one } = await buildIndex('java');
    const { pathBetween } = await import('../src/query.js');
    const from = one('com.acme.web.DonationController').id;
    const to = one('com.acme.repo.JpaDonationRepository').id;

    const found = pathBetween(db, from, to);
    assert.ok(found, 'controller reaches the repository implementation');
    assert.ok(found.length >= 2, 'and not in a single imaginary hop');
    // The chain must pass through the service layer, the way the code runs.
    assert.ok(
      found.hops.some((h) => (h.symbol.fqn ?? '').includes('DonationServiceImpl')),
      'the path goes through the implementation, not around it',
    );
  });

  test('answers null when only the reverse direction exists', async () => {
    const { db, one } = await buildIndex('java');
    const { pathBetween } = await import('../src/query.js');
    const found = pathBetween(
      db,
      one('com.acme.repo.JpaDonationRepository#findAll').id,
      one('com.acme.web.DonationController#list').id,
    );
    assert.equal(found, null, 'edges run caller to callee, and BFS must respect that');
  });

  test('the same symbol is a zero-hop path, not a cycle', async () => {
    const { db, one } = await buildIndex('java');
    const { pathBetween } = await import('../src/query.js');
    const id = one('com.acme.service.DonationServiceImpl#record').id;
    assert.deepEqual(pathBetween(db, id, id), { hops: [], length: 0 });
  });
});

describe('a chained call links to the inner call, not its arguments', () => {
  // `expect(response).to` used to link `.to` back to `response`, because the
  // receiver's ref was taken as "the last ref the subtree pushed" and a call
  // walks its arguments after itself. Every chain whose inner call took an
  // argument lost its type that way -- the single largest miss bucket.
  const cases = [
    ['ruby', 'expect(response).to be_ok', 'expect', 'to'],
    ['java', 'class A { void m() { build(cfg).run(); } }', 'build', 'run'],
    ['typescript', 'wrap(input).then();', 'wrap', 'then'],
  ];

  for (const [lang, code, inner, outer] of cases) {
    test(`${lang}: the outer call points at the inner call`, async () => {
      const { getParser } = await import('../src/lang.js');
      const { extractorFor } = await import('../src/extract/index.js');
      const parser = await getParser(lang);
      const { refs } = extractorFor(lang)(parser.parse(code), code, { path: `x.${lang}` });

      const outerRef = refs.find((r) => r.name === outer);
      assert.ok(outerRef, `no ref for ${outer} in ${refs.map((r) => r.name)}`);
      assert.notEqual(outerRef.receiverRefTmp, null, 'the chain link must exist');
      assert.equal(
        refs[outerRef.receiverRefTmp].name,
        inner,
        `expected the link to reach ${inner}, not ${refs[outerRef.receiverRefTmp]?.name}`,
      );
    });
  }
});

describe('JVM signatures read with javap', () => {
  // The JDK is what makes this testable without downloading anything, but a
  // machine without one is a legitimate setup, so the check is conditional.
  const haveJavap = (() => {
    try {
      spawnSync('javap', ['-help']);
      return spawnSync('javap', ['java.lang.String']).status === 0;
    } catch {
      return false;
    }
  })();

  test('reads return types and generic arguments off a JDK class', { skip: !haveJavap }, async () => {
    const { readSignatures } = await import('../src/jvm.js');
    const [optional] = readSignatures(['java.util.Optional'], '');
    assert.ok(optional, 'javap should describe java.util.Optional');
    assert.equal(optional.fqn, 'java.util.Optional');

    const of = optional.members.find((m) => m.name === 'of');
    assert.ok(of, `expected of(), saw ${optional.members.map((m) => m.name).slice(0, 8)}`);
    assert.match(of.returns, /^java\.util\.Optional</, 'the generic argument must survive');
    assert.equal(of.arity, 1);

    // A constructor returns nothing and would poison a chain if kept.
    assert.ok(
      !optional.members.some((m) => m.name === 'Optional'),
      'constructors are not members that carry a return type',
    );
  });

  test('a method that declares a throws clause is still a member', { skip: !haveJavap }, async () => {
    const { readSignatures } = await import('../src/jvm.js');
    const [future] = readSignatures(['java.util.concurrent.Future'], '');
    assert.ok(future, 'javap should describe java.util.concurrent.Future');

    // javap prints `V get() throws InterruptedException, ExecutionException`.
    // The member match anchors on the closing paren, so the trailing clause
    // used to hide the method outright -- and with it 130 Future.get() calls
    // in netty alone. Roughly a fifth of the JDK's methods declare one.
    const get = future.members.filter((m) => m.name === 'get');
    assert.ok(get.length >= 1, `expected get(), saw ${future.members.map((m) => m.name)}`);
    assert.ok(
      get.some((m) => m.arity === 0),
      'the no-argument overload is the one a chain walks through',
    );
  });

  test('a name the classpath does not have is simply absent', { skip: !haveJavap }, async () => {
    const { readSignatures } = await import('../src/jvm.js');
    const found = readSignatures(['java.util.List', 'com.example.NotAThing'], '');
    const names = found.map((c) => c.fqn);
    assert.ok(names.includes('java.util.List'), 'the real one is still read');
    assert.ok(!names.includes('com.example.NotAThing'), 'the imaginary one yields nothing');
  });
});

describe('dependency declarations are read once, not on every sync', () => {
  test('a re-sync keeps them and does not report them as vanished', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provenlens-ambient-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'A.java'),
      'package d;\nimport java.util.Optional;\npublic class A { Optional<String> f() { return Optional.empty(); } }\n',
    );

    const db = openDb(dbPathFor(root), { create: true });
    try {
      await indexProject(db, root, { full: true });
      const read = db.prepare('SELECT COUNT(*) n FROM files WHERE external = 1').get().n;

      // A dependency row has no path on disk. The pass that prunes files which
      // vanished must not mistake one for a deletion, or every sync would
      // throw away what the last one read and pay to read it again.
      const again = await indexProject(db, root, { full: false });
      assert.equal(again.removed ?? 0, 0, 'nothing vanished');
      assert.equal(
        db.prepare('SELECT COUNT(*) n FROM files WHERE external = 1').get().n,
        read,
        'the declarations survive a sync',
      );
      if (read > 0) assert.equal(again.ambient?.reused, true, 'and are not read a second time');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a .gitignore that un-ignores a vendored node_modules', () => {
  // A repository is free to commit a dependency stub and negate the ignore for it
  // (`!vendor/**/node_modules/**`). That is a statement about what git TRACKS. Read as a
  // statement about what this tool should treat as project source, it made the same .d.ts
  // arrive twice -- once through discovery, once through the ambient reader -- and the
  // second insert hit the files.path UNIQUE constraint and aborted the whole index.
  const build = () => {
    const root = mkdtempSync(join(tmpdir(), 'provenlens-negated-nm-'));
    const stub = join(root, 'vendor', 'stub', 'node_modules', 'tiny-lib');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(stub, { recursive: true });
    writeFileSync(
      join(root, '.gitignore'),
      'node_modules/\n!vendor/**/node_modules/\n!vendor/**/node_modules/**\n',
    );
    writeFileSync(join(stub, 'package.json'), '{"name":"tiny-lib","types":"index.d.ts"}\n');
    writeFileSync(join(stub, 'index.d.ts'), 'export declare function tiny(): string;\n');
    writeFileSync(
      join(root, 'src', 'use.ts'),
      "import { tiny } from 'tiny-lib';\nexport function go(): string { return tiny(); }\n",
    );
    return root;
  };

  test('indexes instead of aborting on files.path', async () => {
    const root = build();
    const db = openDb(dbPathFor(root), { create: true });
    try {
      // Before the fix this threw ERR_SQLITE_ERROR and left the repository unusable.
      const stats = await indexProject(db, root, { full: true });
      assert.ok(stats.parsed > 0, 'the project was indexed');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the vendored dependency is never counted as this project', async () => {
    const root = build();
    const db = openDb(dbPathFor(root), { create: true });
    try {
      await indexProject(db, root, { full: true });
      const own = db
        .prepare("SELECT path FROM files WHERE external = 0")
        .all()
        .map((r) => r.path);
      assert.ok(
        own.every((p) => !p.includes('node_modules')),
        `no node_modules path may be project code, got: ${own.join(', ')}`,
      );
      assert.ok(own.includes('src/use.ts'), 'the real source is still indexed');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the MCP entry the installer writes', () => {
  // It pinned the interpreter that ran the install. Under nvm that path carries the version
  // number, so the server stopped starting the next time the user upgraded Node -- silently,
  // in a config file they had no reason to open.
  test('names no version-stamped interpreter', async () => {
    const { serverEntry } = await import('../src/install.js');
    const entry = serverEntry();
    const words = [entry.command, ...entry.args].join(' ');
    assert.ok(
      !/\/versions\/node\/v\d+/.test(words) && !/\/\.nvm\//.test(words),
      `a version-stamped interpreter path would break on the next upgrade: ${words}`,
    );
  });

  test('runs the bin in a way the platform can actually start', async () => {
    const { serverEntry } = await import('../src/install.js');
    const entry = serverEntry();
    // resolve() gives a native path, so the separator is \ on Windows.
    const bin = /bin[\\/]provenlens\.js$/;
    let binPath;
    if (process.platform === 'win32') {
      // Windows has no shebang: an MCP host hands `command` to CreateProcess,
      // which cannot run a .js file. So the interpreter is named -- as the bare
      // word, resolved from PATH when the host starts it, never as a pinned path.
      assert.equal(entry.command, 'node');
      assert.equal(entry.args.length, 2);
      assert.match(entry.args[0], bin);
      assert.equal(entry.args[1], 'mcp');
      binPath = entry.args[0];
    } else {
      assert.match(entry.command, bin);
      assert.deepEqual(entry.args, ['mcp']);
      binPath = entry.command;
    }

    // The shebang is what lets the file be the command on a POSIX system, and
    // it must name node without pinning an interpreter -- true everywhere, so
    // asserted everywhere.
    assert.match(readFileSync(binPath, 'utf8').split('\n')[0], /^#!.*\bnode\b/);

    // The executable bit is a POSIX fact. Windows has no such mode and npm
    // writes .cmd/.ps1 shims instead, so asserting it there would fail for a
    // reason that says nothing about whether the entry works.
    if (process.platform !== 'win32') {
      assert.ok(statSync(binPath).mode & 0o111, 'the bin must be executable');
    }
  });
});

describe('a default export is a name the module actually declares', () => {
  test('an importer may alias it to anything and still land on the class', async () => {
    // `export default class` names the class, not the export, so asking a
    // module for `default` found nothing and the link fell through to the
    // by-name search. That guess is right whenever the alias happens to match
    // the class name, which is why it hid: in jest the alias is `Worker` and
    // the class is `ChildProcessWorker`, and 31 calls landed on an unrelated
    // `Worker` in another package.
    const project = await tempProject({
      'src/child-process-worker.ts': [
        'export default class ChildProcessWorker {',
        '  send(msg: string) { return msg; }',
        '}',
      ].join('\n'),
      'src/decoy.ts': ['export class Worker {', '  unrelated() { return 1; }', '}'].join('\n'),
      'src/run.ts': [
        "import Worker from './child-process-worker';",
        'export function run() {',
        '  const worker = new Worker();',
        "  return worker.send('hello');",
        '}',
      ].join('\n'),
    });
    try {
      const [hit] = searchSymbols(project.db, 'send', { limit: 5 });
      assert.ok(hit, 'the method exists');
      const callers = callersOf(project.db, hit.id).map((c) => c.fqn);
      assert.ok(
        callers.some((f) => f.includes('run')),
        `run() should call ChildProcessWorker.send, saw ${JSON.stringify(callers)}`,
      );
      // And the decoy must not have been credited with the call.
      const [decoy] = searchSymbols(project.db, 'unrelated', { limit: 5 });
      assert.equal(callersOf(project.db, decoy.id).length, 0);
    } finally {
      project.cleanup();
    }
  });

  test('a module named in a type position is read as the import it is', async () => {
    // `let ts: typeof import('typescript')` is how a file lazily requires a
    // module. Stored as its own literal text it names no type at all, and the
    // by-name search answers with whatever shares the name.
    const project = await tempProject({
      'src/compiler.ts': ['export function transpile(code: string) {', '  return code;', '}'].join('\n'),
      'src/lazy.ts': [
        "let compiler: typeof import('./compiler');",
        'export function go() {',
        "  compiler = require('./compiler');",
        "  return compiler.transpile('x');",
        '}',
      ].join('\n'),
    });
    try {
      const [hit] = searchSymbols(project.db, 'transpile', { limit: 5 });
      const callers = callersOf(project.db, hit.id).map((c) => c.fqn);
      assert.ok(
        callers.some((f) => f.includes('go')),
        `go() should call transpile, saw ${JSON.stringify(callers)}`,
      );
    } finally {
      project.cleanup();
    }
  });
});

describe('an intersection type says more than either half alone', () => {
  test('a member on the right half is found, not blamed on the left', async () => {
    // `let api: DirectusClient<unknown> & RestClient<unknown>`. The generic
    // strip cut at the first `<` and took the rest of the type with it, so the
    // receiver read as `DirectusClient` alone and 187 directus calls on
    // `request` -- which lives on the other half -- were reported as missing
    // from a type that never had it.
    const project = await tempProject({
      'src/client.ts': [
        'export interface ClientBase { url: string; }',
        'export interface RestClient { request(path: string): string; }',
      ].join('\n'),
      'src/use.ts': [
        "import type { ClientBase, RestClient } from './client';",
        'let api: ClientBase & RestClient;',
        'export function go() {',
        "  return api.request('/things');",
        '}',
      ].join('\n'),
    });
    try {
      const [hit] = searchSymbols(project.db, 'request', { limit: 5 });
      assert.ok(hit, 'the method exists');
      const callers = callersOf(project.db, hit.id).map((c) => c.fqn);
      assert.ok(
        callers.some((f) => f.includes('go')),
        `go() should call RestClient.request, saw ${JSON.stringify(callers)}`,
      );
    } finally {
      project.cleanup();
    }
  });

  test('a union is still refused rather than answered with its left half', async () => {
    const project = await tempProject({
      'src/two.ts': [
        'export class Left { act() { return 1; } }',
        'export class Right { act() { return 2; } }',
      ].join('\n'),
      'src/use.ts': [
        "import { Left, Right } from './two';",
        'let either: Left<string> | Right;',
        'export function go() { return either.act(); }',
      ].join('\n'),
    });
    try {
      const [left] = searchSymbols(project.db, 'act', { limit: 5 });
      // Neither side may be credited: the source does not say which it is.
      const credited = searchSymbols(project.db, 'act', { limit: 5 }).filter(
        (s) => callersOf(project.db, s.id).length > 0,
      );
      assert.equal(
        credited.length,
        0,
        `a union names no single receiver, saw ${JSON.stringify(credited.map((c) => c.fqn))}`,
      );
      assert.ok(left, 'the fixture still indexes');
    } finally {
      project.cleanup();
    }
  });
});

describe('a call the language provides is not a miss in this repository', () => {
  test('.bind on a function value is Function.prototype, not a missing member', async () => {
    // n8n writes `const Template: StoryFn = ...` then `Template.bind({})` 128
    // times. The prototype chain ends at Object, so a type that does not
    // declare `bind` is not missing it.
    const project = await tempProject({
      'src/story.ts': [
        'export class Template { render() { return 1; } }',
        'export function make() { return Template.bind({}); }',
      ].join('\n'),
    });
    try {
      const missed = project.db
        .prepare(
          `SELECT u.reason FROM unresolved u JOIN refs r ON r.id = u.ref_id
            WHERE u.external = 0 AND r.name = 'bind'`,
        )
        .all();
      assert.equal(missed.length, 0, `bind should not be reported as a miss, saw ${JSON.stringify(missed)}`);
    } finally {
      project.cleanup();
    }
  });

  test('a proof still outranks the excuse', async () => {
    // "declared nowhere in the project" is a proof; "the runtime provides it"
    // is an assumption the floor strikes off. Consulting the lists first
    // downgraded proofs into assumptions and cost jest half a point of floor.
    const project = await tempProject({
      'src/timers.ts': ['export function go() { clearTimeout(1); }'].join('\n'),
    });
    try {
      const row = project.db
        .prepare(
          `SELECT u.reason FROM unresolved u JOIN refs r ON r.id = u.ref_id
            WHERE r.name = 'clearTimeout'`,
        )
        .get();
      assert.equal(row?.reason, 'external:not-in-project');
    } finally {
      project.cleanup();
    }
  });
});

describe('a parse tree lives in WebAssembly, which the collector cannot reach', () => {
  test('every tree the indexer parses is freed before the next file', async () => {
    // tree-sitter allocates each tree inside its own WASM heap. Nothing in JS
    // holds a reference the garbage collector could act on, so a tree left
    // undeleted is leaked for the life of the process: 6,000 java files reached
    // 1.1 GB against 151 MB once freed, and somewhere inside JetBrainsRuntime's
    // 53,577 the heap ran out and aborted the runtime -- a dead WASM module
    // that took the whole run with it, reported far from the file that did it.
    const { getParser } = await import('../src/lang.js');
    const parser = await getParser('java');
    const seen = [];
    const real = parser.parse.bind(parser);
    parser.parse = (src) => {
      const tree = real(src);
      seen.push(tree);
      return tree;
    };
    try {
      const project = await tempProject({
        'a/A.java': 'package a;\npublic class A { void f() { new B().g(); } }\n',
        'a/B.java': 'package a;\npublic class B { void g() {} }\n',
        'a/C.java': 'package a;\npublic class C { void h() { new A().f(); } }\n',
      });
      try {
        assert.equal(seen.length, 3, 'the fixture should have been parsed');
        for (const tree of seen) {
          assert.throws(
            () => tree.rootNode.type,
            'a tree still readable after indexing is a tree still holding WASM memory',
          );
        }
      } finally {
        project.cleanup();
      }
    } finally {
      parser.parse = real;
    }
  });
});

describe('an extension is a claim about a file, not a fact about it', () => {
  test('a binary file named .ts is not fed to the TypeScript grammar', async () => {
    // shaka-player ships 113 MPEG-2 transport stream segments named `.ts`.
    // Handing 49 MB of video to the TypeScript parser turned a 900-file
    // repository into a run that had not finished after ten minutes, with 83%
    // of the time inside tree-sitter's `ts_node__child` walking an error tree
    // the size of the video. It also filled the index with symbols read out of
    // the noise. A NUL byte near the start is how git tells binary from text.
    const mpegTs = Buffer.alloc(4096);
    for (let i = 0; i < mpegTs.length; i += 188) mpegTs[i] = 0x47; // TS sync byte
    const root = mkdtempSync(join(tmpdir(), 'provenlens-binary-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'video.ts'), mpegTs);
    writeFileSync(
      join(root, 'src', 'real.ts'),
      'export function decode(input: string) { return input; }\n',
    );

    const db = openDb(join(root, 'index.db'), { create: true });
    try {
      const stats = await indexProject(db, root, { full: true });
      assert.equal(stats.unparsable, 1, 'the video is the one file refused');

      const indexed = db
        .prepare('SELECT path FROM files WHERE external = 0 AND lang IS NOT NULL')
        .all()
        .map((r) => r.path);
      assert.deepEqual(indexed, ['src/real.ts'], `saw ${JSON.stringify(indexed)}`);

      // And the real file beside it is still read.
      assert.ok(searchSymbols(db, 'decode', { limit: 3 }).length, 'decode should be indexed');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the heap re-exec runs the arguments it was given', () => {
  test('a caller whose arguments are not commands says so without rewriting argv', async () => {
    // `ensureHeadroom` re-executes argv verbatim. The benchmark script takes a
    // path rather than a command name, and supplying one by rewriting argv
    // dropped the path: the child indexed nothing and reported 0 files at
    // 0.0%, which reads as a broken repository rather than a broken harness.
    const { ensureHeadroom } = await import('../src/heap.js');
    const argv = ['/usr/bin/node', '/tmp/bench.js', '/some/repo'];

    // Without the flag a path is not a command, so nothing happens.
    assert.equal(ensureHeadroom(argv), false);

    // With it, the decision is taken but the guard still short-circuits under
    // test, so this asserts the signature rather than spawning a child.
    const prev = process.env.PROVENLENS_HEAP_SET;
    process.env.PROVENLENS_HEAP_SET = '4096';
    try {
      assert.equal(ensureHeadroom(argv, { indexing: true }), false, 'the guard wins');
    } finally {
      if (prev === undefined) delete process.env.PROVENLENS_HEAP_SET;
      else process.env.PROVENLENS_HEAP_SET = prev;
    }
  });
});

describe('a repository you clone to read must not get to run anything', () => {
  test('only a dotted Java identifier reaches javap', async () => {
    // Every name here came out of the repository's own source, and tree-sitter's
    // error recovery can hand back a "type" whose text is whatever sat between
    // two braces. A value beginning with `-` reaches javap as a flag, and
    // `-J-javaagent:x.jar` is a flag that runs code.
    //
    // The spawn is observed directly. Checking only the return value could not
    // tell "refused before the spawn" from "spawned, failed, swallowed": both
    // come back empty, and the first version of this test passed with the
    // filter deleted.
    const { JAVA_CLASS_NAME, readSignatures } = await import('../src/jvm.js');
    for (const ok of ['java.util.List', 'Foo$Bar', 'a.b.C_1', 'Outer.Inner', '$']) {
      assert.ok(JAVA_CLASS_NAME.test(ok), `${ok} is a class name`);
    }
    for (const bad of ['-J-javaagent:/tmp/x.jar', '-cp', '--illegal', 'a b', 'Foo<Bar>', '../x', 'java..util', '', '.Foo', 'Foo.']) {
      assert.ok(!JAVA_CLASS_NAME.test(bad), `${bad} must be refused`);
    }

    const calls = [];
    const run = (cmd, args) => { calls.push({ cmd, args }); return ''; };

    readSignatures(['-J-javaagent:/tmp/x.jar', '-cp', '../x'], '', { run });
    assert.equal(calls.length, 0, 'nothing valid to ask about, so javap is never started');

    readSignatures(['java.util.List', '-J-javaagent:/tmp/x.jar', 'Foo$Bar'], '/some/classpath.jar', { run });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['-cp', '/some/classpath.jar', 'java.util.List', 'Foo$Bar']);
    assert.ok(
      !calls[0].args.some((a) => a.startsWith('-J')),
      'the flag never reaches argv, even beside names that are fine',
    );
  });

  test('a symlink inside the repository is not read, whatever it points at', async () => {
    const { symlinkSync } = await import('node:fs');
    // Windows refuses symlinks without Developer Mode or an elevated shell.
    // The rule still holds there -- nothing can create the link to test it.
    const probe = mkdtempSync(join(tmpdir(), 'provenlens-symlink-probe-'));
    try {
      writeFileSync(join(probe, 'target'), 'x');
      symlinkSync(join(probe, 'target'), join(probe, 'link'));
    } catch {
      rmSync(probe, { recursive: true, force: true });
      return; // the platform will not make one; there is nothing to assert
    }
    rmSync(probe, { recursive: true, force: true });

    const outside = mkdtempSync(join(tmpdir(), 'provenlens-secret-'));
    const secret = join(outside, 'id_rsa');
    writeFileSync(secret, 'function PRIVATE_KEY_MATERIAL_DO_NOT_INDEX() {}\n');

    const root = mkdtempSync(join(tmpdir(), 'provenlens-symlink-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'real.js'), 'export function real() { return 1; }\n');
    // `x.js -> ~/.ssh/id_rsa` is the shape; the target here just has to be
    // outside the repository and recognisable.
    symlinkSync(secret, join(root, 'src', 'leak.js'));

    const db = openDb(join(root, 'index.db'), { create: true });
    try {
      await indexProject(db, root, { full: true });
      const paths = db.prepare('SELECT path FROM files WHERE external = 0').all().map((r) => r.path);
      assert.ok(paths.includes('src/real.js'), 'the real file is indexed');
      assert.ok(!paths.includes('src/leak.js'), `the symlink must not be, saw ${JSON.stringify(paths)}`);
      assert.equal(
        searchSymbols(db, 'PRIVATE_KEY_MATERIAL_DO_NOT_INDEX', { limit: 3 }).length,
        0,
        'nothing behind the link may enter the index',
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('why: the evidence behind one symbol', () => {
  test('a guessed link is counted apart from a proven one', async () => {
    const { explainSymbol, GUESSED_VIA } = await import('../src/why.js');
    const { formatWhy } = await import('../src/format.js');
    const project = await tempProject({
      'src/a.ts': [
        'export class Store {',
        '  save(x: string) { return x; }',
        '}',
      ].join('\n'),
      'src/b.ts': [
        "import { Store } from './a';",
        'export function run() {',
        '  const store = new Store();',
        "  return store.save('x');",
        '}',
      ].join('\n'),
    });
    try {
      const [hit] = searchSymbols(project.db, 'save', { limit: 3 });
      const why = explainSymbol(project.db, hit.id);
      assert.ok(why, 'the symbol is explainable');
      assert.equal(why.callers.length, 1, 'run() reaches save()');
      // A receiver typed by `new Store()` is a declaration, not a convention.
      assert.equal(why.callers[0].tier, 'proof', `saw ${why.callers[0].via}`);
      assert.equal(why.counts.callers.guess, undefined, 'nothing here is guessed');

      const text = formatWhy(why);
      assert.match(text, /would survive the floor/);
      assert.ok(!text.includes('  ~ '), 'no link is marked as a guess');

      // The list the floor uses and the list this command reports must be the
      // same list, or a symbol's account and the repository's number disagree.
      const bench = readFileSync(join(HERE, '..', 'scripts', 'bench.js'), 'utf8');
      for (const via of GUESSED_VIA) {
        assert.ok(bench.includes(`'${via}'`), `bench must strike ${via} off the floor too`);
      }
    } finally {
      project.cleanup();
    }
  });

  test('an unknown symbol explains nothing rather than guessing', async () => {
    const { explainSymbol } = await import('../src/why.js');
    const { formatWhy } = await import('../src/format.js');
    const project = await tempProject({ 'src/a.ts': 'export function only() { return 1; }\n' });
    try {
      assert.equal(explainSymbol(project.db, 999999), null);
      assert.equal(formatWhy(null), 'No such symbol.');
    } finally {
      project.cleanup();
    }
  });
});

describe('the action this repository ships', () => {
  test('action.yml declares what a consumer needs and asks for no secrets', () => {
    // A composite action is only as good as its contract, and a fork's pull
    // request gets no secrets: an action that needs one works for the author
    // and for nobody else. This asserts the shape that avoids it.
    const raw = readFileSync(join(HERE, '..', 'action.yml'), 'utf8');

    assert.match(raw, /using:\s*composite/, 'composite, so no build artefact to publish');
    for (const input of ['paths', 'depth', 'fail-if-untested']) {
      assert.match(raw, new RegExp(`^\\s{2}${input}:`, 'm'), `input ${input} is declared`);
    }
    for (const output of ['report', 'reached', 'tests']) {
      assert.match(raw, new RegExp(`^\\s{2}${output}:`, 'm'), `output ${output} is declared`);
    }
    assert.ok(!/\$\{\{\s*secrets\./.test(raw), 'no secret is read, so fork PRs work');

    // The merge-base, not the base tip. Diffing against the tip reports every
    // file the base branch moved on since, which is not this pull request.
    assert.match(raw, /git merge-base/, 'the diff is taken against the merge-base');

    // Failing is opt-in: a call graph is evidence for a reviewer, and a repo
    // should turn it into a gate on purpose rather than by installing it.
    assert.match(raw, /fail-if-untested:[\s\S]{0,400}?default: 'false'/, 'gating is opt-in');

    // npm symlinks a local path unless told otherwise, and a symlinked package
    // resolves its dependencies from the source directory -- which on a runner
    // has none. It passed locally for the one reason it must not be trusted:
    // the developer's checkout already had node_modules.
    assert.match(raw, /npm install[^\n]*--install-links/, 'the package is copied, not linked');
  });
});
