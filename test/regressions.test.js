import { test, before, after, describe } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildIndex } from './helpers.js';
import { openDb } from '../src/db.js';
import { indexProject } from '../src/indexer.js';
import { searchSymbols, callersOf, affectedBy, isTestPath } from '../src/query.js';
import { buildIgnoreFilter, dbPathFor } from '../src/project.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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
    // the top-level directory, so installing dependencies triggered endless
    // reindexing.
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
  const CLI = join(HERE, '..', 'bin', 'codelens.js');
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
    covered = mkdtempSync(join(tmpdir(), 'codelens-gate-a-'));
    bare = mkdtempSync(join(tmpdir(), 'codelens-gate-b-'));
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
