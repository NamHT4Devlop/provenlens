import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { classify, singularize } from '../src/extract/ruby.js';
import { callersOf, calleesOf, impactOf } from '../src/query.js';

let db;
let one;
let stats;
let missedCalls;
let externalCalls;

before(async () => {
  ({ db, one, stats, missedCalls, externalCalls } = await buildIndex('ruby'));
});

describe('inflection', () => {
  test('singularizes the common shapes', () => {
    assert.equal(singularize('donations'), 'donation');
    assert.equal(singularize('line_items'), 'line_item');
    assert.equal(singularize('companies'), 'company');
    assert.equal(singularize('boxes'), 'box');
    assert.equal(singularize('status'), 'status');
  });

  test('classifies an association name into a class name', () => {
    assert.equal(classify('line_items'), 'LineItem');
    assert.equal(classify('donor'), 'Donor');
  });
});

describe('extraction', () => {
  test('indexes every fixture file', () => {
    assert.equal(stats.parsed, 11);
  });

  test('turns belongs_to into a reader typed with the associated class', () => {
    const donor = one('Donation#donor');
    assert.equal(donor.type_name, 'Donor');
    assert.ok(JSON.parse(donor.modifiers).includes('generated'));
    assert.deepEqual(JSON.parse(donor.annotations), ['belongs_to']);
  });

  test('marks has_many readers as collections', () => {
    const items = one('Donation#line_items');
    assert.equal(items.type_name, 'LineItem');
    assert.ok(JSON.parse(items.modifiers).includes('collection'));
  });

  test('records include as a supertype for method lookup', () => {
    const supertypes = JSON.parse(
      db.prepare('SELECT supertypes FROM types WHERE fqn = ?').get('DonationRecorder').supertypes,
    );
    assert.deepEqual(supertypes, ['Auditable']);
  });

  test('distinguishes singleton methods from instance methods', () => {
    assert.equal(one('DonationRecorder.call').kind, 'class_method');
    assert.equal(one('DonationRecorder#record').kind, 'method');
  });
});

describe('resolution', () => {
  test('chains two layers of metaprogramming: belongs_to reader then attr_reader', () => {
    // Donation#summary calls donor.name. `donor` exists only because of
    // belongs_to, and `name` only because of attr_reader.
    const name = one('Donor#name');
    const callers = callersOf(db, name.id);
    // Receipt#name joined later: the delegate forward calls the same target.
    assert.deepEqual(
      callers.map((c) => c.fqn).sort(),
      ['Donation#summary', 'Receipt#name'],
    );
    const summary = callers.find((c) => c.fqn === 'Donation#summary');
    assert.equal(summary.via, 'rails-association');
    assert.ok(summary.confidence < 1, 'an inferred association edge must not claim certainty');
  });

  test('resolves a mixin method through the include chain', () => {
    const audit = one('Auditable#audit');
    const caller = callersOf(db, audit.id).find((c) => c.fqn === 'DonationRecorder#record');
    assert.ok(caller, 'expected the service object to reach the mixin method');
    // Via the ancestor chain, not by matching the name and hoping.
    assert.equal(caller.via, 'self-chain');
  });

  test('traces controller -> service object -> instance method', () => {
    const record = one('DonationRecorder#record');
    const reached = impactOf(db, record.id).levels.flat().map((s) => s.fqn);
    assert.ok(reached.includes('DonationRecorder.call'));
    assert.ok(reached.includes('DonationsController#create'));
  });

  test('links bare new(...) to the initialize it runs', () => {
    const init = one('DonationRecorder#initialize');
    assert.ok(callersOf(db, init.id).some((c) => c.fqn === 'DonationRecorder.call'));
  });

  test('types a local from X.new and follows the call on it', () => {
    // `donation = Donation.new(...)` then `donation.save`, where save lives on
    // the ApplicationRecord superclass.
    const save = one('ApplicationRecord#save');
    assert.ok(callersOf(db, save.id).some((c) => c.fqn === 'DonationRecorder#record'));
  });

  test('drops bare identifiers instead of reporting them as missed calls', () => {
    assert.ok(stats.resolve.ruby.dropped > 0);
    assert.ok(
      ![...missedCalls(), ...externalCalls()].includes('(self).amount'),
      'a local variable read must not be counted as a call at all',
    );
  });

  test('misses nothing that lives in the fixture', () => {
    assert.deepEqual(missedCalls(), []);
  });

  test('attributes each remaining call to the gem it comes from', () => {
    assert.deepEqual(externalCalls(), [
      '(self).format',
      '(self).protect_from_forgery',
      '(self).render',
      '(self).render',
      '(self).validates',
      'Donation.all',
      'Rails.logger',
      'Rails.logger.info',
      'donations.sum',
    ]);
  });

  test('names the gem rather than just saying external', () => {
    const owners = db
      .prepare('SELECT DISTINCT owner FROM unresolved WHERE external = 1 ORDER BY owner')
      .all()
      .map((r) => r.owner);
    // render comes from the controller base class, validates from the model one.
    assert.ok(owners.includes('ActionController::Base'));
    assert.ok(owners.includes('ActiveRecord::Base'));
  });
});

describe('metaprogramming the resolver follows', () => {
  test('delegate writes a forwarding method and links it to the real target', () => {
    const forward = one('Receipt#name');
    assert.match(forward.signature, /generated by delegate/);

    // The forward behaves like handwritten code: it calls Donor#name.
    const out = calleesOf(db, forward.id).map((c) => c.fqn);
    assert.ok(out.includes('Donor#name'), `expected Donor#name among ${out}`);
  });

  test('a bare call inside the class reaches the delegated reader', () => {
    const header = one('Receipt#header');
    const out = calleesOf(db, header.id).map((c) => c.fqn);
    assert.ok(out.includes('Receipt#name'), `expected the delegate, saw ${out}`);
  });

  test('included-do macros ride the include into the class', () => {
    // has_one and attr_reader written inside `included do` belong to whoever
    // includes the concern, reached through the module chain.
    const sealed = one('Receipt#sealed?');
    const viaModule = calleesOf(db, sealed.id).map((c) => c.fqn);
    assert.ok(viaModule.includes('Stampable#stamp!'), `saw ${viaModule}`);

    const stamp = one('Stampable#stamp!');
    const readers = calleesOf(db, stamp.id).map((c) => c.fqn);
    assert.ok(readers.includes('Stampable#stamped_at'), `saw ${readers}`);
  });

  test('a dead-end call on a class defining method_missing lands there, marked as such', () => {
    const caller = one('Receipt#config_value');
    const out = calleesOf(db, caller.id);
    const mm = out.find((c) => c.fqn === 'SettingsStore#method_missing');
    assert.ok(mm, `expected the interceptor, saw ${out.map((c) => c.fqn)}`);
    assert.equal(mm.via, 'method-missing');
    assert.ok(mm.confidence <= 0.4, 'an interception is an assumption, not a proof');
  });

  test('method_missing is a last resort, never a shortcut past real members', () => {
    // lookup() exists, so calls to it must keep resolving directly.
    const inside = one('SettingsStore#method_missing');
    const out = calleesOf(db, inside.id);
    const direct = out.find((c) => c.fqn === 'SettingsStore#lookup');
    assert.ok(direct, 'the real member still wins');
    assert.notEqual(direct.via, 'method-missing');
  });
});

describe('the Rails naming convention, held to a member check', () => {
  test('an untyped `donor` reaches Donor, because Donor declares the method', () => {
    const link = calleesOf(db, one('DonorNotifier#notify').id).find(
      (c) => c.fqn === 'Donor#total_given',
    );
    assert.ok(link, 'expected the convention to type the parameter');
    assert.equal(link.via, 'name-convention');
    assert.ok(link.confidence <= 0.5, 'a convention is never a certainty');
  });

  test('a name matching no class does not go through the convention', () => {
    // `widget` names nothing in the repo. Anything reached from it is the
    // older unique-name fallback, which is a weaker guess and labelled as one.
    const out = calleesOf(db, one('DonorNotifier#skip').id);
    assert.ok(
      out.every((c) => c.via !== 'name-convention'),
      `the convention must not fire here: ${out.map((c) => c.via)}`,
    );
  });
});
