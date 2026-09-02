import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { normalizeType, elementOf, modulePathOf } from '../src/extract/typescript.js';
import { readTsconfigPaths } from '../src/resolve/typescript.js';
import { callersOf, calleesOf, impactOf, searchSymbols } from '../src/query.js';

let db;
let one;
let root;
let stats;
let missedCalls;
let externalCalls;

before(async () => {
  ({ db, one, root, stats, missedCalls, externalCalls } = await buildIndex('ts'));
});

const calls = (fqnSuffix) => {
  const sym = one(fqnSuffix);
  return calleesOf(db, sym.id)
    .filter((c) => c.edge_kind === 'calls')
    .map((c) => c.fqn.split(':').pop());
};

describe('type normalisation', () => {
  test('keeps the array suffix so an array is not mistaken for its element', () => {
    assert.equal(normalizeType('Donation[]'), 'Donation[]');
    assert.equal(normalizeType('Promise<Donation>'), 'Promise');
    assert.equal(normalizeType(': string'), 'string');
  });

  test('refuses to guess at a union of two real types', () => {
    assert.equal(normalizeType('Donation | Invoice'), null);
    // The generic strip used to cut at the first `<`, taking the rest of the
    // type with it -- so a union the check above should have refused was
    // answered with its left operand instead.
    assert.equal(normalizeType('Donation<Id> | Invoice'), null);
  });

  test('keeps an intersection, which says more than either half alone', () => {
    // A union is an ambiguity; an intersection is not. `A & B` says the value
    // has every member of both, so the resolver is given both to look through.
    assert.equal(normalizeType('Donation & Serializable'), 'Donation&Serializable');
    assert.equal(normalizeType('DirectusClient<unknown> & RestClient<unknown>'), 'DirectusClient&RestClient');
    // Anything that is not a plain name on either side is still a refusal.
    assert.equal(normalizeType('{ a: number } & B'), null);
  });

  test('reads an optional as the type it is optional of', () => {
    // Not a guess: null and undefined have no members, so a call written on
    // such a receiver can only be targeting the other side of the union --
    // which is why TypeScript makes the author narrow or assert it first.
    assert.equal(normalizeType('Donation | null'), 'Donation');
    assert.equal(normalizeType('Donation | undefined'), 'Donation');
    assert.equal(elementOf('Promise<Donation | undefined>'), 'Donation');
  });

  test('derives a module path from a file path', () => {
    assert.equal(modulePathOf('src/domain/donation.ts'), 'src/domain/donation');
    assert.equal(modulePathOf('src/lib/format.js'), 'src/lib/format');
  });
});

describe('module resolution', () => {
  test('reads path aliases out of tsconfig', () => {
    const { paths } = readTsconfigPaths(root);
    assert.deepEqual(paths['@domain/*'], ['src/domain/*']);
  });

  test('resolves an aliased import across to a plain .js file', () => {
    // donationService.ts imports formatAmount from '@lib/format', a JS module.
    const fmt = one('formatAmount');
    assert.equal(fmt.lang, 'javascript');
    assert.deepEqual(
      callersOf(db, fmt.id).map((c) => c.fqn.split(':').pop()),
      ['DonationService#summarise'],
    );
  });

  test('follows export * through a barrel file', () => {
    // The controller imports Donation from '../domain', which re-exports it.
    assert.ok(calls('DonationController#fromRaw').includes('Donation#describe'));
  });

  test('follows a named re-export through a barrel file', () => {
    assert.ok(calls('DonationController#seed').includes('DonationRepository#save'));
  });
});

describe('extraction', () => {
  test('qualifies symbols by module so same-named classes stay distinct', () => {
    assert.equal(one('DonationService').fqn, 'src/service/donationService:DonationService');
  });

  test('turns a constructor parameter property into a field', () => {
    const field = one('DonationService#repository');
    assert.equal(field.kind, 'field');
    assert.equal(field.type_name, 'DonationRepository');
    assert.ok(JSON.parse(field.modifiers).includes('parameter-property'));
  });

  test('records implements clauses', () => {
    const supertypes = JSON.parse(
      db
        .prepare('SELECT supertypes FROM types WHERE fqn = ?')
        .get('src/repo/donationRepository:InMemoryDonationRepository').supertypes,
    );
    assert.deepEqual(supertypes, ['DonationRepository']);
  });
});

describe('resolution', () => {
  test('routes an injected interface call to the implementation', () => {
    const impl = one('InMemoryDonationRepository#findAll');
    const callers = callersOf(db, impl.id);
    assert.ok(callers.some((c) => c.via === 'interface->impl'));
    assert.ok(callers.every((c) => c.confidence < 1), 'inferred edges must not claim certainty');
  });

  test('traces controller -> service -> repository implementation', () => {
    const impl = one('InMemoryDonationRepository#findAll');
    const reached = impactOf(db, impl.id).levels.flat().map((s) => s.fqn.split(':').pop());
    assert.ok(reached.includes('DonationService#listAll'));
    assert.ok(reached.includes('DonationController#list'));
  });

  test('infers a local type from the callee return type', () => {
    // `const donation = this.service.record(...)` then `donation.describe()`.
    const describe_ = one('Donation#describe');
    const fromCreate = callersOf(db, describe_.id).find(
      (c) => c.fqn.endsWith('DonationController#create'),
    );
    assert.ok(fromCreate, 'expected create() to reach describe()');
    assert.equal(fromCreate.confidence, 1, 'a declared return type is not a guess');
  });

  test('does not resolve an array receiver to its element type', () => {
    // `private store: Donation[]` -- store.push is Array.push, not a Donation member.
    assert.ok(
      !calls('InMemoryDonationRepository#save').some((c) => c.startsWith('Donation#push')),
      'push must not be attributed to Donation',
    );
  });

  test('needs no by-name guessing on this fixture', () => {
    assert.equal(stats.resolve.typescript.uniqueName, 0);
  });

  test('recognises an array receiver as the runtime Array, not project code', () => {
    const arrayPush = db
      .prepare(
        `SELECT u.owner FROM unresolved u JOIN refs r ON r.id = u.ref_id
          WHERE r.name = 'push' AND u.external = 1`,
      )
      .get();
    assert.equal(arrayPush.owner, 'Array', 'store.push is Array.push, named as such');
  });

  test('proves untyped JS calls target the runtime, since nothing declares them', () => {
    // format.js has no annotations, so `amount` has no type to follow -- but
    // no symbol named toFixed exists anywhere here, so the call provably does
    // not target this project.
    const proven = db
      .prepare(
        `SELECT r.name FROM unresolved u JOIN refs r ON r.id = u.ref_id
          WHERE u.reason = 'external:not-in-project' ORDER BY r.name`,
      )
      .all()
      .map((r) => r.name);
    assert.deepEqual(proven, ['toFixed', 'toUpperCase', 'trim']);
  });

  test('leaves nothing genuinely missed in this fixture', () => {
    assert.deepEqual(missedCalls(), []);
  });
});

describe('decorators and generics', () => {
  test('Array<T> types a receiver exactly like T[]', async () => {
    const { normalizeType } = await import('../src/extract/typescript.js');
    assert.equal(normalizeType('Array<Donation>'), 'Donation[]');
    assert.equal(normalizeType('ReadonlyArray<Donation>'), 'Donation[]');
    // A nested generic argument is not a simple element type; stay honest.
    assert.equal(normalizeType('Array<Map<string, number>>'), 'Array');
  });
});

describe('CommonJS, which no export keyword announces', () => {
  test('a function declaration is a constructor, across a require()', () => {
    // `var Ledger = require('./legacy')` where legacy does `module.exports =
    // Ledger` and Ledger is a plain function. Every hop of that was invisible.
    const built = callersOf(db, one('Ledger').id).map((c) => c.fqn);
    assert.ok(
      built.some((f) => f.includes('build')),
      `expected the require()d constructor to be reached, saw ${built}`,
    );
  });

  test('require() resolves a named member the same way an import does', () => {
    const callers = callersOf(db, one('formatDonor').id).map((c) => c.fqn);
    assert.ok(
      callers.some((f) => f.includes('build')),
      `expected the require()d function to be reached, saw ${callers}`,
    );
  });
});

describe('declarations read from a dependency', () => {
  test('a call on a dependency-typed receiver is proven external, not missed', () => {
    // `this.ledger.post(...)` where Ledger is declared only in node_modules.
    // Reading the declaration is what turns this from "we could not work the
    // receiver out" into "it provably leaves the project".
    const row = db
      .prepare(
        `SELECT u.external, u.owner, u.reason FROM unresolved u
           JOIN refs r ON r.id = u.ref_id WHERE r.name = 'post' AND r.receiver = 'this.ledger'`,
      )
      .get();
    assert.ok(row, 'expected the call to be accounted for');
    assert.equal(row.external, 1, `expected external, got ${row.reason}`);
    assert.equal(row.owner, 'tiny-lib', 'and named after the package it came from');
  });

  test('the dependency is read but never counted as this project', () => {
    const mine = db.prepare('SELECT COUNT(*) n FROM files WHERE external = 0').get().n;
    const theirs = db.prepare('SELECT COUNT(*) n FROM files WHERE external = 1').get().n;
    assert.ok(theirs > 0, 'the stub dependency should have been read');
    assert.ok(
      !db.prepare("SELECT 1 FROM files WHERE external = 0 AND path LIKE 'node_modules/%'").get(),
      'and none of it counted as project code',
    );
    assert.equal(mine, stats.parsed, 'project file count is the parsed count, nothing more');
  });

  test('a dependency symbol never turns up in a search of this project', () => {
    const hits = searchSymbols(db, 'Ledger', { limit: 20 });
    assert.ok(
      hits.every((h) => !h.file_path.startsWith('node_modules/')),
      `search must stay inside the project: ${hits.map((h) => h.file_path)}`,
    );
  });
});
