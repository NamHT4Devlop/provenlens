import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
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

  test('takes over a lock held by a live PID that is far too old to be a run', () => {
    // A PID is reused once its process exits, so "alive" can be true of a
    // stranger. Our own PID is certainly alive; a lock in its name that is
    // hours old is not a run of ours still going, because no run is.
    const root = mkdtempSync(join(tmpdir(), 'provenlens-lock-'));
    try {
      mkdirSync(join(root, '.provenlens'));
      const lock = join(root, '.provenlens', 'index.lock');
      writeFileSync(lock, String(process.pid));
      const fourHoursAgo = (Date.now() - 4 * 60 * 60 * 1000) / 1000;
      utimesSync(lock, fourHoursAgo, fourHoursAgo);
      const release = acquireIndexLock(root);
      assert.equal(readFileSync(lock, 'utf8'), String(process.pid), 'the lock is ours now');
      release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('still refuses a fresh lock held by a live PID', () => {
    const root = mkdtempSync(join(tmpdir(), 'provenlens-lock-'));
    try {
      mkdirSync(join(root, '.provenlens'));
      writeFileSync(join(root, '.provenlens', 'index.lock'), String(process.pid));
      assert.throws(() => acquireIndexLock(root), (err) => err.code === 'PROVENLENS_LOCKED');
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
