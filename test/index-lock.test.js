import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireIndexLock } from '../src/project.js';

describe('index lock', () => {
  test('a second run on the same project is refused, not allowed to race', () => {
    const root = mkdtempSync(join(tmpdir(), 'provenlens-lock-'));
    try {
      mkdirSync(join(root, '.provenlens'));
      const release = acquireIndexLock(root);
      // Two runs rebuild the same symbols from different snapshots; the loser
      // dies on a foreign key with the index half written. Refusing is the
      // outcome that leaves a usable index behind.
      assert.throws(() => acquireIndexLock(root), (err) => err.code === 'PROVENLENS_LOCKED');
      release();
      // Released, so the next run may proceed.
      acquireIndexLock(root)();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('takes over a lock whose process is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'provenlens-lock-'));
    try {
      mkdirSync(join(root, '.provenlens'));
      // A machine that lost power mid-index must not block the project for
      // ever, so a lock naming a dead process is taken rather than obeyed.
      writeFileSync(join(root, '.provenlens', 'index.lock'), '999999');
      const release = acquireIndexLock(root);
      assert.equal(readFileSync(join(root, '.provenlens', 'index.lock'), 'utf8'), String(process.pid));
      release();
      assert.equal(existsSync(join(root, '.provenlens', 'index.lock')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not lock, or litter, a tree with no index directory', () => {
    // A benchmark or a test keeps its database elsewhere. There is nothing
    // shared to protect, and creating a directory to hold a lock would leave
    // a footprint in a tree that never asked for one.
    const root = mkdtempSync(join(tmpdir(), 'provenlens-lock-'));
    try {
      acquireIndexLock(root)();
      assert.equal(existsSync(join(root, '.provenlens')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
