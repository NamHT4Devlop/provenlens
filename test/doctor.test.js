import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex } from './helpers.js';
import { diagnose } from '../src/doctor.js';
import { nodeModulesRoots } from '../src/ambient.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('doctor', () => {
  describe('a TypeScript project whose imports are all tsconfig aliases', () => {
    let report;
    before(async () => {
      const { db, root } = await buildIndex('ts');
      report = diagnose(db, root);
    });

    test('does not report this repo\'s own aliases as uninstalled packages', () => {
      // `@domain/donation` reads exactly like a package name and is this
      // repository's own source. Reporting it would send someone to npm for
      // something npm has never heard of, and every enterprise TypeScript
      // project is full of these.
      const blocking = report.findings.filter((f) => f.level === 'blocking');
      assert.deepEqual(
        blocking,
        [],
        `nothing here needs installing, got: ${JSON.stringify(blocking)}`,
      );
    });

    test('every finding carries a fix, not just a complaint', () => {
      for (const f of report.findings) {
        assert.ok(f.why && f.fix, `finding without why/fix: ${JSON.stringify(f)}`);
      }
    });
  });

  describe('a Ruby project', () => {
    let report;
    before(async () => {
      const { db, root } = await buildIndex('ruby');
      report = diagnose(db, root);
    });

    test('reports the absence of declarations as inherent, not as a fault', () => {
      // Nothing to install would change it, and saying otherwise would send
      // someone looking for a package that does not exist.
      const ruby = report.findings.find((f) => f.level === 'inherent');
      assert.ok(ruby, 'expected an inherent finding for Ruby');
      assert.match(ruby.fix, /nothing to install/);
    });
  });
});

describe('workspace layout', () => {
  test('finds a node_modules that a workspace package keeps beside itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'codelens-ws-'));
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      mkdirSync(join(root, 'packages', 'ui', 'node_modules'), { recursive: true });
      mkdirSync(join(root, 'node_modules', '.pnpm', 'node_modules'), { recursive: true });

      const found = nodeModulesRoots(root);
      assert.ok(found.includes(join(root, 'node_modules')));
      assert.ok(
        found.includes(join(root, 'packages', 'ui', 'node_modules')),
        'a workspace package keeps its dependencies beside itself',
      );
      // The flat store is the fallback, so it must come after the real ones.
      assert.equal(found.at(-1), join(root, 'node_modules', '.pnpm', 'node_modules'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
