import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { indexProject } from '../src/indexer.js';
import { searchSymbols, impactOf, callersOf } from '../src/query.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', '__fixtures__', 'java');
const TMP_DB = join(HERE, '..', '__fixtures__', '.test-index.db');

let db;
let stats;

before(async () => {
  rmSync(TMP_DB, { force: true });
  rmSync(`${TMP_DB}-wal`, { force: true });
  rmSync(`${TMP_DB}-shm`, { force: true });
  db = openDb(TMP_DB, { create: true });
  stats = await indexProject(db, FIXTURE, { full: true });
});

const one = (q) => {
  const hits = searchSymbols(db, q, { limit: 5 });
  assert.ok(hits.length, `expected a match for "${q}"`);
  return hits[0];
};

describe('extraction', () => {
  test('indexes every fixture file', () => {
    assert.equal(stats.parsed, 7);
    assert.ok(stats.symbols > 30, `expected >30 symbols, got ${stats.symbols}`);
  });

  test('records package, supertypes and annotations', () => {
    const impl = one('DonationServiceImpl');
    assert.equal(impl.fqn, 'com.acme.service.DonationServiceImpl');
    assert.equal(impl.kind, 'class');
    assert.deepEqual(JSON.parse(impl.annotations), ['Service']);

    const supertypes = JSON.parse(
      db.prepare('SELECT supertypes FROM types WHERE fqn = ?').get(impl.fqn).supertypes,
    );
    assert.deepEqual(supertypes.sort(), ['BaseService', 'DonationService']);
  });

  test('builds method signatures with parameter types', () => {
    assert.equal(one('DonationServiceImpl#record').signature, 'Donation record(String, int)');
  });

  test('captures field types so receivers can be typed', () => {
    const field = one('DonationServiceImpl#repository');
    assert.equal(field.kind, 'field');
    assert.equal(field.signature, 'DonationRepository repository');
  });
});

describe('resolution', () => {
  test('links a call through an injected interface to the implementation', () => {
    // DonationController#list calls donationService.listAll(); donationService is
    // declared as the DonationService interface, so the impl must be reachable.
    const implMethod = one('DonationServiceImpl#listAll');
    const callers = callersOf(db, implMethod.id).map((c) => c.fqn);
    assert.ok(
      callers.includes('com.acme.web.DonationController#list'),
      `expected the controller among callers, got: ${callers.join(', ')}`,
    );
  });

  test('traces the full controller -> service -> repository chain', () => {
    const findAll = one('DonationRepository#findAll');
    const impact = impactOf(db, findAll.id);
    const reached = impact.levels.flat().map((s) => s.fqn);

    assert.ok(reached.includes('com.acme.service.DonationServiceImpl#listAll'));
    assert.ok(reached.includes('com.acme.web.DonationController#list'));
    assert.ok(reached.includes('com.acme.web.DonationController#total'));
  });

  test('resolves an inherited call to the superclass that declares it', () => {
    // DonationServiceImpl#record calls audit(), declared on BaseService.
    const audit = one('BaseService#audit');
    const callers = callersOf(db, audit.id).map((c) => c.fqn);
    assert.deepEqual(callers, ['com.acme.service.DonationServiceImpl#record']);
  });

  test('marks interface-derived edges as lower confidence than direct ones', () => {
    const rows = db.prepare('SELECT DISTINCT via, confidence FROM edges').all();
    const viaImpl = rows.find((r) => r.via === 'interface->impl');
    assert.ok(viaImpl && viaImpl.confidence < 1);
  });

  test('leaves only genuinely external calls unresolved', () => {
    const reasons = db
      .prepare(
        `SELECT r.receiver, r.name FROM unresolved u JOIN refs r ON r.id = u.ref_id`,
      )
      .all()
      .map((r) => `${r.receiver ?? '-'}.${r.name}`);

    // Everything left over must be JDK surface, not project code.
    assert.deepEqual(
      reasons.sort(),
      ['-.ArrayList', 'System.out.println', 'd.getId().equals', 'store.add'].sort(),
    );
  });
});
