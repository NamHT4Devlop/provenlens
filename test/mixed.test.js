import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { callersOf } from '../src/query.js';

/**
 * Indexes every fixture at once, i.e. one repo holding Java, Ruby, TypeScript
 * and JavaScript. Resolvers run one after another over a shared database, so
 * this is what catches one language wiping another's graph.
 */
let db;
let one;
let stats;

before(async () => {
  ({ db, one, stats } = await buildIndex('.'));
});

const edgeCountFor = (lang) =>
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM edges e
         JOIN symbols s ON s.id = e.from_symbol_id
         JOIN files f   ON f.id = s.file_id
        WHERE f.lang = ? AND e.kind = 'calls'`,
    )
    .get(lang).n;

describe('multi-language project', () => {
  test('indexes all four languages together', () => {
    const langs = Object.keys(stats.byLang).sort();
    assert.deepEqual(langs, ['java', 'javascript', 'ruby', 'typescript']);
  });

  test('every language keeps its own call graph', () => {
    // A resolver that deleted edges globally would zero out the others here.
    for (const lang of ['java', 'ruby', 'typescript', 'javascript']) {
      const n = edgeCountFor(lang);
      if (lang === 'javascript') continue; // the JS fixture only defines functions
      assert.ok(n > 0, `${lang} has no call edges — another resolver wiped them`);
    }
  });

  test('runs a resolver once per resolver, not once per language', () => {
    assert.deepEqual(Object.keys(stats.resolve).sort(), ['java', 'ruby', 'typescript']);
  });

  test('keeps same-named symbols from different languages apart', () => {
    // All three fixtures declare a Donation class; each must stay addressable.
    const rows = db
      .prepare(
        `SELECT f.lang, s.fqn FROM symbols s JOIN files f ON f.id = s.file_id
          WHERE s.name = 'Donation' AND s.kind = 'class' ORDER BY f.lang`,
      )
      .all();
    assert.deepEqual(
      rows.map((r) => `${r.lang}:${r.fqn}`),
      [
        'java:com.acme.domain.Donation',
        'ruby:Donation',
        'typescript:ts/src/domain/donation:Donation',
      ],
    );
  });

  test('does not link a call in one language to a method in another', () => {
    const javaSave = one('DonationRepository#save');
    const callerLangs = new Set(callersOf(db, javaSave.id).map((c) => c.lang));
    assert.ok(!callerLangs.has('ruby'), 'a Ruby caller must not reach a Java method');
    assert.ok(!callerLangs.has('typescript'), 'a TS caller must not reach a Java method');
  });
});
