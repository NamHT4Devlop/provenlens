import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { impactOf, callersOf, calleesOf } from '../src/query.js';

let db;
let one;
let stats;
let missedCalls;
let externalCalls;

before(async () => {
  ({ db, one, stats, missedCalls, externalCalls } = await buildIndex('java'));
});

describe('extraction', () => {
  test('indexes every fixture file', () => {
    assert.equal(stats.parsed, 14);
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

  test('picks the overload whose parameter types match the arguments', () => {
    // DonationFormatter#report calls describe(donation) and describe(fallback);
    // both overloads take one argument, so arity alone cannot separate them.
    const targets = calleesOf(db, one('DonationFormatter#report').id)
      .filter((c) => c.name === 'describe')
      .map((c) => c.signature)
      .sort();
    assert.deepEqual(targets, ['String describe(Donation)', 'String describe(String)']);
  });

  test('types a literal argument when choosing an overload', () => {
    // describe(donation, verbose) has a distinct arity, so it must not be chosen
    // for the single-argument calls above.
    const oneArgCalls = calleesOf(db, one('DonationFormatter#report').id).filter(
      (c) => c.name === 'describe',
    );
    assert.ok(oneArgCalls.every((c) => c.arity === 1));
  });

  test('misses nothing that lives in the fixture', () => {
    assert.deepEqual(missedCalls(), []);
  });

  test('attributes every remaining call to the JDK', () => {
    assert.deepEqual(externalCalls(), [
      '(self).ArrayList',
      'System.out.println',
      'd.getId().equals',
      'receipts.forEach',
      'store.add',
    ]);
  });
});

describe('members the compiler writes and the source does not', () => {
  test('Lombok @Data gives every field a getter and a setter', () => {
    const getter = one('Receipt#getNote');
    assert.match(getter.signature, /lombok/);
    assert.equal(getter.type_name, 'String');
    // A boolean field reads as isX(), the way Lombok spells it.
    assert.ok(one('Receipt#isSettled'), 'boolean getter must be isSettled');
    assert.ok(one('Receipt#setNote'), 'and a setter exists too');
  });

  test('@Builder models the builder, so a build chain keeps its type', () => {
    // Receipt.builder().note("x").build() must end up holding a Receipt.
    const callees = calleesOf(db, one('Ledger#summarise').id).map((c) => c.fqn);
    assert.ok(callees.includes('com.acme.lombok.Receipt.ReceiptBuilder#build'), callees.join(' '));
    assert.ok(callees.includes('com.acme.lombok.Receipt#setSettled'), 'the built value is a Receipt');
  });

  test('@Accessors(chain) makes a setter return the object it set', () => {
    const setter = one('Ticket#setSeat');
    assert.equal(setter.type_name, 'com.acme.lombok.Ticket');
    const callees = calleesOf(db, one('Ledger#summarise').id).map((c) => c.fqn);
    assert.ok(callees.includes('com.acme.lombok.Ticket#getSeat'), 'so the next call still resolves');
  });

  test('a record component compiles to an accessor of the same name', () => {
    // The field and the accessor share a name, exactly as they do in Java.
    const members = db
      .prepare("SELECT name, kind, type_name FROM symbols WHERE container_fqn = 'com.acme.lombok.Stamp'")
      .all();
    const accessor = members.find((m) => m.name === 'code' && m.kind === 'method');
    assert.ok(accessor, `no accessor among ${JSON.stringify(members)}`);
    assert.equal(accessor.type_name, 'String');
  });
});

describe('generics carry the element type into a lambda', () => {
  test('a declared type argument types the lambda parameter', () => {
    // receipts is List<Receipt>, so `receipt` in forEach is a Receipt.
    const callees = calleesOf(db, one('Ledger#summarise').id).map((c) => c.fqn);
    assert.ok(callees.includes('com.acme.lombok.Receipt#getNote'), callees.join(' '));
  });

  test('a Foo.class argument types it too, which is how generic APIs say so', () => {
    // store.load(Receipt.class, ...).map(found -> found.getId())
    const callees = calleesOf(db, one('Ledger#summarise').id).map((c) => c.fqn);
    assert.ok(callees.includes('com.acme.lombok.Receipt#getId'), callees.join(' '));
  });
});
