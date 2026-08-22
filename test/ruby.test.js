import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { classify, singularize } from '../src/extract/ruby.js';
import { callersOf, impactOf } from '../src/query.js';

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
    assert.equal(stats.parsed, 7);
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
    assert.deepEqual(
      callers.map((c) => c.fqn),
      ['Donation#summary'],
    );
    assert.equal(callers[0].via, 'rails-association');
    assert.ok(callers[0].confidence < 1, 'an inferred association edge must not claim certainty');
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
