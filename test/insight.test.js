import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { deadCode, cycles, hotspots } from '../src/insight.js';

describe('hotspots', () => {
  let rows;
  before(async () => {
    const { db } = await buildIndex('java');
    rows = hotspots(db, { limit: 10 });
  });

  test('ranks by who depends on it, not by how much it does', () => {
    assert.ok(rows.length, 'expected at least one symbol with a caller');
    for (const r of rows) assert.ok(r.callers > 0, 'a hotspot must have callers');
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].callers >= rows[i].callers, 'sorted by callers descending');
    }
  });
});

describe('dead code', () => {
  test('a framework entry point is never called dead', async () => {
    const { db, root } = await buildIndex('java');
    const report = deadCode(db, root, { limit: 100, onlyCertain: false });
    // @Controller, @Bean and friends are called by something this graph will
    // never contain. Reporting one would send someone to delete a route.
    for (const c of report.candidates) {
      const annotations = JSON.parse(c.annotations || '[]').join(' ');
      assert.doesNotMatch(
        annotations,
        /@(Bean|Controller|RestController|Service|Scheduled|Test|Override)/,
        `${c.fqn} is a framework entry point and must not be listed`,
      );
    }
  });

  test('reports how much went unresolved, because that is what the list is worth', async () => {
    const { db, root } = await buildIndex('java');
    const report = deadCode(db, root, {});
    assert.equal(typeof report.unresolved, 'number');
    assert.equal(typeof report.refs, 'number');
  });

  test('says nothing rather than accusing a whole public API', async () => {
    const { db, root } = await buildIndex('ruby');
    const report = deadCode(db, root, {});
    // Every candidate that survives the default must be one the graph could
    // actually be sure about.
    for (const c of report.candidates) assert.equal(c.confidence, 'high');
  });
});

describe('cycles', () => {
  test('reports each ring once, however it is entered', async () => {
    const { db } = await buildIndex('ts');
    const rings = cycles(db, { limit: 20 });
    const keys = rings.map((r) => [...r].sort().join('|'));
    assert.equal(new Set(keys).size, keys.length, 'the same ring must not appear twice');
    for (const ring of rings) {
      assert.equal(new Set(ring).size, ring.length, 'a ring must not repeat a file');
    }
  });
});
