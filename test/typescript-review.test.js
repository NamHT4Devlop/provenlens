/**
 * The TypeScript defects a full review found, each pinned by the probe that
 * found it: a destructuring that read nothing, a type argument taken for a
 * supertype, a field that was a method, a bare call typed as a member of the
 * class around it, and four ways a module can be named that resolved to a
 * dependency.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';

let db;
let missed;

before(async () => {
  const built = await buildIndex('ts2');
  db = built.db;
  missed = built.missedCalls;
});

const edgesFrom = (fqn) =>
  db
    .prepare(
      `SELECT t.fqn AS target, e.kind, e.via, e.confidence FROM edges e
         JOIN symbols s ON s.id = e.from_symbol_id
         JOIN symbols t ON t.id = e.to_symbol_id
        WHERE s.fqn = ? ORDER BY t.fqn`,
    )
    .all(fqn);
const calls = (fqn) => edgesFrom(fqn).filter((e) => e.kind === 'calls').map((e) => e.target);
const symbol = (fqn) => db.prepare('SELECT id, kind, fqn, container_fqn, modifiers FROM symbols WHERE fqn = ?').get(fqn);
const unresolvedIn = (fqn) =>
  db
    .prepare(
      `SELECT r.receiver, r.name, u.reason FROM unresolved u JOIN refs r ON r.id = u.ref_id
         JOIN symbols s ON s.id = r.from_symbol_id WHERE s.fqn = ? ORDER BY r.line`,
    )
    .all(fqn)
    .map((r) => ({ ...r }));

describe('a destructuring declaration reads its initialiser', () => {
  test('const { data } = await client.get() reaches Client#get', () => {
    assert.deepEqual(calls('src/use/use:d1'), ['src/lib/lib:Client#get']);
  });
});

describe('a bare call holds what its function returns', () => {
  test('const t = make(); t.a() reaches Thing#a', () => {
    assert.ok(calls('src/use/use:bare').includes('src/lib/lib:Thing#a'), `got ${calls('src/use/use:bare')}`);
  });
});

describe('a type argument is not a supertype', () => {
  test('extends Base<User> inherits Base only', () => {
    const supers = edgesFrom('src/use/use:Comp').filter((e) => e.kind === 'extends').map((e) => e.target);
    assert.deepEqual(supers, ['src/lib/lib:Base']);
  });

  test('so a call to a User member on a Comp is a miss, not a declaration', () => {
    assert.deepEqual(calls('src/use/use:useComp'), []);
    assert.ok(unresolvedIn('src/use/use:useComp').some((u) => u.name === 'userMethod' && !u.reason.startsWith('external')));
  });
});

describe('class fields', () => {
  test('an arrow field is a method whose `this` is the class', () => {
    assert.equal(symbol('src/use/use:Comp#handleClick')?.kind, 'method');
    const e = edgesFrom('src/use/use:Comp#handleClick');
    assert.ok(e.some((x) => x.target === 'src/use/use:Comp#load' && x.via === 'direct'), `got ${JSON.stringify(e)}`);
  });

  test('a field initialised with `new` has that type', () => {
    assert.deepEqual(calls('src/use/use:Comp#load'), ['src/lib/lib:Logger#log']);
  });
});

describe('an object literal inside a method is not the class', () => {
  test('inner() is not a member of Comp, and this.inner() is a miss', () => {
    assert.equal(symbol('src/use/use:Comp#inner'), undefined);
    assert.deepEqual(calls('src/use/use:Comp#run'), []);
  });
});

describe('super and abstract', () => {
  test('super.describe() reaches the parent', () => {
    assert.deepEqual(calls('src/use/use:Comp#sup'), ['src/lib/lib:Base#describe']);
  });

  test('an abstract method signature is a member', () => {
    assert.equal(symbol('src/use/use:Shape#area')?.kind, 'method');
    assert.deepEqual(calls('src/use/use:Shape#describe'), ['src/use/use:Shape#area']);
  });
});

describe('names a scope binds', () => {
  test('a for-of variable holds the element', () => {
    assert.deepEqual(calls('src/use/use:loop'), ['src/lib/lib:Item#render']);
  });

  test('a destructured parameter binds each member', () => {
    const t = calls('src/use/use:props');
    assert.ok(t.includes('src/lib/lib:Thing#a'), `store.a() -> Thing#a, got ${t}`);
    assert.ok(t.includes('src/lib/lib:Item#render'), `it.render() -> Item#render, got ${t}`);
  });

  test('a single-parameter arrow binds its parameter', () => {
    assert.deepEqual(calls('src/use/use:single'), ['src/lib/lib:Thing#a']);
  });

  test('an arrow declared inside a function does not shadow the module', () => {
    assert.equal(symbol('src/use/use:load'), undefined, 'the local arrow is not a module-level function');
    assert.deepEqual(calls('src/use/use:shadow'), ['src/use/use:shadow.load']);
    assert.deepEqual(calls('src/use/use:callsLoad'), ['src/lib/lib:load']);
  });
});

describe('module shapes that resolved to a dependency', () => {
  test('export * as ns from ./a', () => {
    assert.deepEqual(calls('src/use/use:viaNs'), ['src/ns/a:fa']);
  });

  test('import x = require() with export =', () => {
    assert.deepEqual(calls('src/use/use:viaRequire'), ['src/lib/cc:CC#cm']);
  });

  test('export { App as default }', () => {
    assert.deepEqual(calls('src/use/use:viaDefault'), ['src/lib/appdef:App#run']);
  });

  test('a workspace package with only an exports map', () => {
    assert.deepEqual(calls('src/use/use:viaExports'), ['packages/core/lib/index:Core#boot']);
  });

  test('a tsconfig that only extends one with baseUrl and paths', () => {
    assert.deepEqual(calls('src/use/use:viaBaseUrl'), ['src/lib/lib:Thing#a']);
    assert.deepEqual(calls('src/use/use:bare').filter((t) => t.endsWith(':make')), ['src/lib/lib:make']);
  });

  test('a .d.ts declares the module its name says', () => {
    assert.deepEqual(calls('src/use/use:viaDts'), ['src/types/api:ApiClient#fetch']);
  });

  test('export default function () {} is a function this module exports', () => {
    assert.equal(symbol('src/lib/anon:default')?.kind, 'function');
    assert.deepEqual(calls('src/use/use:viaAnon'), ['src/lib/anon:default']);
  });
});

describe('what is left', () => {
  test('the only in-repo miss is the one the fixture plants', () => {
    // useComp calls a member Comp does not have, and Comp#run calls a method
    // that belongs to an object literal. Everything else resolves.
    const left = missed().filter((m) => !m.startsWith('(self).') || true);
    assert.deepEqual(left, ['c.userMethod', 'this.inner']);
  });
});
