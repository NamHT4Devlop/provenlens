import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { normalizeType, modulePathOf } from '../src/extract/typescript.js';
import { readTsconfigPaths } from '../src/resolve/typescript.js';
import { callersOf, calleesOf, impactOf } from '../src/query.js';

let db;
let one;
let root;
let stats;
let unresolvedCalls;

before(async () => {
  ({ db, one, root, stats, unresolvedCalls } = await buildIndex('ts'));
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

  test('refuses to guess at a union', () => {
    assert.equal(normalizeType('Donation | null'), null);
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

  test('leaves only runtime built-ins unresolved', () => {
    assert.deepEqual(unresolvedCalls(), [
      'amount.toFixed',
      'name.trim',
      'name.trim().toUpperCase',
      'this.store.push',
    ]);
  });
});
