/**
 * The Java defects a full review found, each pinned by the probe that found
 * it: a static import declared a library, a `var` typed from the wrong call,
 * method references that were nothing, comments counted as arguments, a
 * method's own type variable resolved to a real class, enum constants that
 * did not exist.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';

let db;
let missed;
let external;

before(async () => {
  const built = await buildIndex('java2');
  db = built.db;
  missed = built.missedCalls;
  external = built.externalCalls;
});

const edgesFrom = (fqn) =>
  db
    .prepare(
      `SELECT t.fqn AS target, e.kind, e.via, e.confidence FROM edges e
         JOIN symbols s ON s.id = e.from_symbol_id
         JOIN symbols t ON t.id = e.to_symbol_id
        WHERE s.fqn = ? ORDER BY t.fqn, e.kind`,
    )
    .all(fqn);
const calls = (fqn) => edgesFrom(fqn).filter((e) => e.kind === 'calls').map((e) => e.target);
const symbol = (fqn) => db.prepare('SELECT id, kind, fqn, type_name FROM symbols WHERE fqn = ?').get(fqn);
const targetSignatures = (fqn) =>
  db
    .prepare(
      `SELECT t.signature FROM edges e JOIN symbols s ON s.id = e.from_symbol_id
         JOIN symbols t ON t.id = e.to_symbol_id WHERE s.fqn = ? AND e.kind = 'calls' ORDER BY e.line, t.signature`,
    )
    .all(fqn)
    .map((r) => r.signature);

describe('a static import of a project method is a call into the project', () => {
  test('compute() reaches Helper#compute', () => {
    assert.deepEqual(calls('com.acme.x.Use#staticImport'), ['com.acme.a.Helper#compute']);
  });
});

describe('var is typed from its own initialiser', () => {
  test('var v = h.first(h.second()) holds a Foo', () => {
    const t = calls('com.acme.x.Use#varTyping');
    assert.ok(t.includes('com.acme.a.Foo#fooOnly'), `got ${t}`);
  });
});

describe('method references and constructor chaining are calls', () => {
  test('Helper::compute, this::run and Helper::new', () => {
    const e = edgesFrom('com.acme.x.Use#refs');
    assert.ok(e.some((x) => x.target === 'com.acme.a.Helper#compute'), `got ${JSON.stringify(e)}`);
    assert.ok(e.some((x) => x.target === 'com.acme.x.Use#run'));
    assert.ok(e.some((x) => x.target === 'com.acme.a.Helper' && x.kind === 'instantiates'));
  });

  test('this(1) calls the other constructor; super(x) calls the parent one', () => {
    const own = edgesFrom('com.acme.x.Use#Use').filter((e) => e.kind === 'calls').map((e) => e.target);
    assert.ok(own.includes('com.acme.x.Use#Use'), `this(1) -> Use(int), got ${own}`);
    assert.ok(own.includes('com.acme.a.Base#Base'), `super(x) -> Base(int), got ${own}`);
  });
});

describe('arguments are counted without their comments', () => {
  test('f(1 /* first */, 2) is the two-argument overload', () => {
    const sigs = targetSignatures('com.acme.x.Use#comments');
    assert.equal(sigs[0], 'void f(int, int)', `got ${sigs}`);
  });

  test('varargs accept any count, and a count no overload takes is not linked', () => {
    const sigs = targetSignatures('com.acme.x.Use#comments');
    assert.ok(sigs.includes('void h(String...)'), `got ${sigs}`);
    assert.ok(!sigs.slice(2).includes('void f(int)'), 'f(1,2,3,4) must not link to f(int)');
  });
});

describe('a method-level type variable is not a class', () => {
  test('<Entity> void each(Entity e) does not link e.hashCode() to Entity', () => {
    const e = edgesFrom('com.acme.x.Use#each');
    assert.ok(!e.some((x) => x.target.startsWith('com.acme.a.Entity')), `got ${JSON.stringify(e)}`);
  });
});

describe('a comment in an implements list is not a supertype', () => {
  test('Use inherits Base, Runnable and Serializable only', () => {
    const t = JSON.parse(db.prepare('SELECT supertypes FROM types WHERE fqn = ?').get('com.acme.x.Use').supertypes);
    assert.ok(!t.some((s) => s.includes('//')), `got ${t}`);
  });
});

describe('dotted receivers', () => {
  test('a nested type and a fully qualified name both resolve', () => {
    const t = calls('com.acme.x.Use#nested');
    assert.ok(t.includes('com.acme.a.Helper.Inner#create'), `got ${t}`);
    assert.ok(t.includes('com.acme.a.Helper.Inner#innerTag'), `got ${t}`);
    assert.ok(t.includes('com.acme.a.Helper#compute'), `got ${t}`);
  });
});

describe('bindings the grammar spells its own way', () => {
  test('an instanceof pattern is typed, and var is no type at all', () => {
    assert.deepEqual(calls('com.acme.x.Use#patterns'), ['com.acme.a.Helper#tag']);
    // `for (var h : ...)` declares h with no type; it was stored as a type
    // called `var`, which then resolved by guess.
    const h = db
      .prepare(
        `SELECT l.type_name FROM locals l JOIN symbols s ON s.id = l.scope_symbol_id
          WHERE s.fqn = 'com.acme.x.Use#patterns' AND l.name = 'h'`,
      )
      .get();
    assert.equal(h?.type_name ?? null, null);
  });

  test('a typed lambda parameter keeps its type', () => {
    assert.deepEqual(calls('com.acme.x.Use#typedLambda'), ['com.acme.a.Helper#tag']);
  });
});

describe('enum constants', () => {
  test('are fields, call the constructor, and a body is a subclass', () => {
    assert.equal(symbol('com.acme.a.Color#RED')?.kind, 'field');
    assert.equal(symbol('com.acme.a.Color#RED')?.type_name, 'Color');
    const ctorCalls = db
      .prepare(
        `SELECT COUNT(*) AS n FROM edges e JOIN symbols t ON t.id = e.to_symbol_id
          WHERE t.fqn = 'com.acme.a.Color#Color' AND e.kind = 'calls'`,
      )
      .get().n;
    assert.ok(ctorCalls >= 2, `RED("r") and GREEN("g") call the constructor, got ${ctorCalls}`);
    // The body's label() lives on an anonymous subclass, not on Color twice.
    const labels = db.prepare("SELECT container_fqn FROM symbols WHERE name = 'label'").all().map((r) => r.container_fqn);
    assert.equal(labels.filter((c) => c === 'com.acme.a.Color').length, 1);
    assert.ok(labels.some((c) => c !== 'com.acme.a.Color'));
    assert.deepEqual(calls('com.acme.x.Use#enums'), ['com.acme.a.Color#label']);
  });
});

describe('what is left', () => {
  test('the misses are the ones the fixture plants', () => {
    // f(1, 2, 3, 4) fits no overload and is reported rather than linked; the
    // `var` loop variable has no type to resolve from. The call on the
    // type-variable parameter is a JDK method on an untyped receiver, and
    // says so rather than naming a class the code never mentioned.
    assert.deepEqual(missed().sort(), ['h.tag', 'o.f']);
    assert.ok(external().includes('e.hashCode'));
    assert.ok(!external().includes('(self).compute'), 'the static import is not a library call');
  });
});
