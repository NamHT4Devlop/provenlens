/**
 * The Ruby defects a full review found, each pinned by the probe that found
 * it: a proof that never fired, a class reopened into losing its ancestors,
 * `class << self` read as instance methods, a def outside any class that
 * nothing could reach, `super(x)` doubled, a parameter read as a call, a
 * writer resolved to its reader, a Struct with no class behind it.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';

let db;
let one;

before(async () => {
  const built = await buildIndex('ruby2');
  db = built.db;
  one = built.one;
});

const edgesFrom = (fqn) =>
  db
    .prepare(
      `SELECT t.fqn AS target, e.via, e.confidence FROM edges e
         JOIN symbols s ON s.id = e.from_symbol_id
         JOIN symbols t ON t.id = e.to_symbol_id
        WHERE s.fqn = ? AND e.kind = 'calls' ORDER BY t.fqn`,
    )
    .all(fqn);
const targets = (fqn) => edgesFrom(fqn).map((e) => e.target);
const unresolvedIn = (fqn) =>
  db
    .prepare(
      `SELECT r.receiver, r.name, u.reason FROM unresolved u JOIN refs r ON r.id = u.ref_id
         JOIN symbols s ON s.id = r.from_symbol_id WHERE s.fqn = ? ORDER BY r.line`,
    )
    .all(fqn);
const symbol = (fqn) => db.prepare('SELECT id, kind, fqn FROM symbols WHERE fqn = ?').get(fqn);

describe('a receiver declared nowhere is a proof, not a guess', () => {
  test('response.body in a spec leaves the repository', () => {
    const rows = unresolvedIn('spec/user_spec.rb').filter((r) => r.receiver === 'response');
    assert.equal(rows.length, 1, 'the call must be recorded as unresolved');
    assert.equal(rows[0].reason, 'external:receiver-not-declared');
    // And no edge was invented to the unrelated Somewhere#body.
    const invented = db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges e JOIN symbols t ON t.id = e.to_symbol_id
          WHERE t.fqn = 'Somewhere#body'`,
      )
      .get().n;
    assert.equal(invented, 0);
  });
});

describe('a class reopened in a second file keeps its ancestors', () => {
  test('User still inherits ApplicationRecord and includes Auditable', () => {
    const t = db.prepare('SELECT supertypes FROM types WHERE fqn = ?').get('User');
    assert.deepEqual(JSON.parse(t.supertypes).sort(), ['ApplicationRecord', 'Auditable']);
  });

  test('so a call through the model is a declaration, not a name match', () => {
    const e = edgesFrom('Consumer#go');
    const save = e.find((x) => x.target === 'ApplicationRecord#save');
    assert.ok(save, `expected ApplicationRecord#save, got ${JSON.stringify(e)}`);
    assert.equal(save.via, 'direct');
    assert.ok(e.some((x) => x.target === 'Auditable#audit'));
  });

  test('an ivar assigned in one file types a call in the other', () => {
    assert.deepEqual(targets('User#extra'), ['Policy#allowed']);
  });

  test('an endless method still declares what it returns', () => {
    assert.ok(targets('Consumer#go').includes('LogAdapter#info'), `got ${targets('Consumer#go')}`);
  });
});

describe('class << self', () => {
  test('defines class methods, and a bare call inside one prefers a class method', () => {
    assert.equal(symbol('User.build')?.kind, 'class_method');
    assert.equal(symbol('User.helper')?.kind, 'class_method');
    assert.equal(symbol('User#build'), undefined);
    const e = edgesFrom('User.build');
    assert.ok(e.some((x) => x.target === 'User.helper'), `got ${JSON.stringify(e)}`);
    assert.ok(!e.some((x) => x.target === 'User#helper'));
  });

  test('a bare `new` in a class method instantiates the class', () => {
    const inst = db
      .prepare(
        `SELECT t.fqn FROM edges e JOIN symbols s ON s.id = e.from_symbol_id
           JOIN symbols t ON t.id = e.to_symbol_id
          WHERE s.fqn = 'User.build' AND e.kind = 'instantiates'`,
      )
      .all()
      .map((r) => r.fqn);
    assert.deepEqual(inst, ['User']);
  });
});

describe('a def outside any class', () => {
  test('is a method on Object that a bare call anywhere reaches', () => {
    assert.equal(symbol('Object#top_helper')?.kind, 'method');
    assert.deepEqual(targets('Object#top_main'), ['Object#top_helper']);
    // From a spec's example block, which has no class around it at all.
    assert.ok(targets('spec/user_spec.rb').includes('Object#build_user'));
  });
});

describe('super', () => {
  test('super() is one call, to the ancestor, with its arity', () => {
    const refs = db
      .prepare(
        `SELECT r.name, r.receiver, r.arity FROM refs r JOIN symbols s ON s.id = r.from_symbol_id
          WHERE s.fqn = 'User#touch_it'`,
      )
      .all()
      .map((r) => ({ ...r }));
    assert.deepEqual(refs, [{ name: 'touch_it', receiver: 'super', arity: 0 }]);
  });
});

describe('a bound name is a variable, not a call', () => {
  test('the parameter `name` is not an edge to the `name` reader', () => {
    // The only thing initialize does that the graph can see is build a
    // Policy; the `name` it reads is its own parameter.
    assert.deepEqual(targets('User#initialize'), []);
    const built = db
      .prepare(
        `SELECT t.fqn FROM edges e JOIN symbols s ON s.id = e.from_symbol_id
           JOIN symbols t ON t.id = e.to_symbol_id
          WHERE s.fqn = 'User#initialize' AND e.kind = 'instantiates'`,
      )
      .all()
      .map((r) => r.fqn);
    assert.deepEqual(built, ['Policy']);
  });
});

describe('writers', () => {
  test('obj.attr = v calls attr=, and += calls both', () => {
    const t = targets('User#rename');
    assert.ok(t.includes('User#name='), `expected the writer, got ${t}`);
    assert.ok(t.includes('User#name'), 'the += form reads first');
    const writers = edgesFrom('User#rename').filter((e) => e.target === 'User#name=');
    assert.ok(writers.length >= 1);
  });
});

describe('classes made by a factory', () => {
  test('Struct.new and Class.new declare classes with members', () => {
    assert.equal(symbol('Point')?.kind, 'class');
    assert.equal(symbol('Point#dist')?.kind, 'method');
    assert.equal(symbol('Point#x')?.kind, 'method');
    assert.equal(symbol('Derived')?.kind, 'class');
    assert.deepEqual(JSON.parse(db.prepare('SELECT supertypes FROM types WHERE fqn = ?').get('Derived').supertypes), ['Policy']);
    const t = targets('Uses#run');
    assert.ok(t.includes('Point#dist') && t.includes('Derived#hello'), `got ${t}`);
    assert.deepEqual(targets('Derived#hello'), ['Policy#allowed']);
  });
});

describe('metaprogramming that declares', () => {
  test('define_method, alias_method and alias are methods with callers and callees', () => {
    assert.equal(symbol('User#dyn')?.kind, 'method');
    assert.deepEqual(targets('User#dyn'), ['User#helper']);
    assert.deepEqual(targets('User#older_name'), ['User#name']);
    assert.deepEqual(targets('User#newest_name'), ['User#name']);
  });

  test('a callback macro is a call from the class', () => {
    const t = targets('User');
    for (const name of ['User#normalize', 'User#needs_normalize?', 'User#check_name']) {
      assert.ok(t.includes(name), `expected ${name}, got ${t}`);
    }
  });

  test('a scope lambda is the body of the scope', () => {
    const t = targets('User.visible');
    assert.ok(t.includes('Policy.allowed'), `got ${t}`);
  });
});

describe('search still finds the model', () => {
  test('User#name is one symbol, from the first declaration', () => {
    assert.equal(one('User#name').fqn, 'User#name');
  });
});
