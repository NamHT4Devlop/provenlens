/**
 * The call sites an answer used to leave out.
 *
 * `callers perform_async` on sidekiq answered "one" while 87 call sites named
 * perform_async sat unresolved -- `thing.save` with `thing` untyped and two
 * `save` methods declared is recorded as ambiguous, not drawn, and a declined
 * edge read exactly like no call. Every answer about a symbol's callers now
 * carries those sites, apart from the edges and never counted among them.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildIndex } from './helpers.js';
import { candidateCallersOf, candidateTestsFor, arityFits, unlinkedReason } from '../src/unlinked.js';
import { formatRelations, formatImpact, formatExplore, formatAffected, formatNode } from '../src/format.js';
import { deadCode } from '../src/insight.js';
import { afterEdit } from '../src/hook.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'provenlens.js');

describe('candidates by name', () => {
  let db, root, one;
  before(async () => ({ db, root, one } = await buildIndex('unlinked')));

  test('an ambiguous call is a candidate for every declaration it could mean', () => {
    // `thing.save` in Service#run: `thing` is a parameter, typed nowhere.
    const order = candidateCallersOf(db, one('Order#save'));
    const user = candidateCallersOf(db, one('User#save'));
    assert.ok(order.sites.some((s) => s.file_path === 'lib/service.rb' && s.line === 9));
    assert.ok(user.sites.some((s) => s.file_path === 'lib/service.rb' && s.line === 9));
    assert.equal(order.sites[0].reason, 'ambiguous-name');
  });

  test('arity rules out a declaration the call could not be', () => {
    // `record.save(1, 2, 3)` in the spec: Order#save takes *args, User#save takes none.
    const order = candidateCallersOf(db, one('Order#save'));
    const user = candidateCallersOf(db, one('User#save'));
    assert.ok(order.sites.some((s) => s.file_path === 'spec/order_spec.rb'));
    assert.ok(!user.sites.some((s) => s.file_path === 'spec/order_spec.rb'));
    assert.equal(order.total, 2);
    assert.equal(order.inTests, 1);
    assert.equal(user.total, 1);
  });

  test('TypeScript: fewer arguments fit an optional parameter, more do not', () => {
    // `thing.run(1)`: A#run(x) can take it, B#run() cannot.
    assert.equal(candidateCallersOf(db, one('A#run')).total, 1);
    assert.equal(candidateCallersOf(db, one('B#run')).total, 0);
  });

  test('a call in another language family is never a candidate', () => {
    // Ruby's Service#run shares its name with the TypeScript call `thing.run(1)`.
    assert.equal(candidateCallersOf(db, one('Service#run')).total, 0);
  });

  test('the rules for arity, stated on their own', () => {
    const ruby = (sig, arity) => ({ lang: 'ruby', signature: sig, arity });
    assert.equal(arityFits(ruby('save(*args)', 1), { arity: 3 }), true);
    assert.equal(arityFits(ruby('save()', 0), { arity: 3 }), false);
    assert.equal(arityFits(ruby('save(a, b)', 2), { arity: 1 }), true);
    assert.equal(arityFits(ruby('save(a)', 1), { arity: null }), true);
    const java = (sig, arity, params) => ({ lang: 'java', signature: sig, arity, params });
    assert.equal(arityFits(java('void f(int, int)', 2, '["int","int"]'), { arity: 1 }), false);
    assert.equal(arityFits(java('void h(String...)', 1, '["String..."]'), { arity: 4 }), true);
    assert.equal(arityFits(java('void f(int, int)', 2, '["int","int"]'), { arity: 2 }), true);
  });

  test('production files come before tests, and each reason is worded for a reader', () => {
    const c = candidateCallersOf(db, one('Order#save'));
    assert.deepEqual(c.files.map((f) => f.file), ['lib/service.rb', 'spec/order_spec.rb']);
    assert.match(unlinkedReason('ambiguous-name'), /declared in more than one place/);
    assert.match(unlinkedReason('complex-receiver-chain'), /result of another call/);
    assert.equal(unlinkedReason('something-new'), 'something-new');
  });

  test('a changed model lists the specs that call its names on an untyped receiver', () => {
    const changed = db
      .prepare(`SELECT s.*, f.path AS file_path, f.lang FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = 'lib/order.rb'`)
      .all();
    const maybe = candidateTestsFor(db, changed);
    assert.equal(maybe.length, 1);
    assert.equal(maybe[0].file, 'spec/order_spec.rb');
    assert.deepEqual(maybe[0].names, ['save']);
    assert.deepEqual(maybe[0].lines, [6]);
  });

  test('every answer about callers carries the section, apart from the edges', () => {
    const sym = one('Order#save');
    for (const text of [
      formatRelations(db, sym.id, 'callers'),
      formatImpact(db, sym.id),
      formatNode(db, root, sym.id),
      formatExplore(db, root, 'Order#save'),
    ]) {
      assert.match(text, /### Unlinked call sites named `save` \(2, 1 in tests\)/);
      assert.match(text, /spec\/order_spec\.rb:6/);
      assert.match(text, /candidates by name, not edges/);
    }
    // The other direction has no such section: a callee is a call this symbol wrote.
    assert.doesNotMatch(formatRelations(db, sym.id, 'callees'), /Unlinked call sites/);
    // And nothing here became an edge or a count.
    assert.match(formatImpact(db, sym.id), /0 symbol\(s\) across 0 file\(s\)/);
  });

  test('affected names the tests it could not prove reach the change', () => {
    const text = formatAffected(db, ['lib/order.rb']);
    assert.match(text, /### Tests that already cover it \(0\)/);
    assert.match(text, /### Tests that may cover it by name \(1 file\(s\)/);
    assert.match(text, /spec\/order_spec\.rb:6 — calls `save` on an untyped receiver/);
  });

  test('the edit hook says so too', () => {
    const text = afterEdit(db, root, join(root, 'lib/order.rb'));
    assert.match(text, /covered by: no existing test reaches this/);
    assert.match(text, /maybe covered by 1 test file\(s\).*spec\/order_spec\.rb/);
  });

  test('dead will not call a name unreached while a call it could not link shares it', () => {
    const certain = deadCode(db, root, {});
    assert.ok(!certain.candidates.some((c) => c.name === 'save'));
    assert.ok(certain.nameHeldBack >= 2, 'both save methods are held back');
    const all = deadCode(db, root, { onlyCertain: false });
    const save = all.candidates.find((c) => c.fqn === 'Order#save');
    assert.equal(save.confidence, 'medium');
    assert.equal(save.unlinkedSameName, 2);
  });
});

describe('the command line', () => {
  test('callers, dead and affected print the candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'provenlens-unlinked-'));
    try {
      cpSync(join(HERE, '..', '__fixtures__', 'unlinked'), root, { recursive: true });
      const run = (...args) =>
        execFileSync(process.execPath, ['--no-warnings', BIN, ...args], { cwd: root, encoding: 'utf8' });
      run('init', root);
      const callers = run('callers', 'Order#save');
      assert.match(callers, /Nothing calls this symbol/);
      assert.match(callers, /Unlinked call sites named `save` \(2, 1 in tests\)/);
      assert.match(callers, /lib\/service\.rb:9/);

      const dead = run('dead');
      assert.match(dead, /name\(s\) not shown because a call site nobody could link shares their name/);
      const deadAll = run('dead', '--public');
      assert.match(deadAll, /Order#save  \(2 unlinked call site\(s\) share this name\)/);

      const affected = run('affected', 'lib/order.rb');
      assert.match(affected, /Tests that may cover it by name/);
      const json = JSON.parse(run('affected', 'lib/order.rb', '--json'));
      assert.deepEqual(json.testCandidates.map((t) => t.file), ['spec/order_spec.rb']);

      const impact = JSON.parse(run('impact', 'Order#save', '--json'));
      assert.equal(impact.totalSymbols, 0);
      assert.equal(impact.unlinked.total, 2);
      assert.equal(impact.unlinked.sites[1].file, 'spec/order_spec.rb');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
