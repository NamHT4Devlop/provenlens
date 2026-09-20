/**
 * STRUCTURE.md and the scaffold script are for a machine that cannot clone
 * this repository. A path list written once is wrong one pull request later
 * and nothing says so; these keep both true, and prove the claim the page
 * leans on -- that package.json, yarn.lock, bin/ and src/ are all it takes to
 * run the tool.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, cpSync, symlinkSync, existsSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { ROOT, OUTPUTS, trackedFiles, inTier } from '../scripts/gen-structure.js';

const inGit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
})();
// System32\bash.exe on a Windows runner is the WSL launcher, not a shell.
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;

const walk = (dir, base = dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1).split('\\').join('/'));
  }
  return out.sort();
};

describe('the structure page and the scaffold', { skip: !inGit && 'not a git checkout' }, () => {
  test('both match the files git tracks', () => {
    const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gen-structure.js'), '--check'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || 'run: node scripts/gen-structure.js');
  });

  test('the scaffold creates exactly the tracked tree, empty, and never overwrites', { skip: !hasBash && 'no bash' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'provenlens-scaffold-'));
    try {
      const script = join(ROOT, OUTPUTS.script);
      const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });
      const all = join(dir, 'all');
      assert.match(run(all).stdout, /\(all\): \d+ file\(s\) created, 0 already present/);
      assert.deepEqual(walk(all), trackedFiles().map((f) => f.path).sort());
      assert.equal(statSync(join(all, 'src/db.js')).size, 0, 'files are created empty');
      assert.ok(statSync(join(all, 'bin/provenlens.js')).mode & 0o100, 'the binary is executable');

      // Pasted code survives a second run.
      writeFileSync(join(all, 'src/db.js'), 'pasted');
      assert.match(run(all).stdout, /0 file\(s\) created, \d+ already present/);
      assert.equal(readFileSync(join(all, 'src/db.js'), 'utf8'), 'pasted');

      const runtime = join(dir, 'runtime');
      run('--runtime', runtime);
      assert.deepEqual(walk(runtime), trackedFiles().map((f) => f.path).filter((p) => inTier(p, 'runtime')).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the runtime tier is enough to index a repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provenlens-runtime-'));
    try {
      const copy = join(dir, 'provenlens');
      for (const { path } of trackedFiles().filter((f) => inTier(f.path, 'runtime'))) {
        mkdirSync(dirname(join(copy, path)), { recursive: true });
        cpSync(join(ROOT, path), join(copy, path));
      }
      // What `yarn install` would put there. A junction needs no privilege on Windows.
      symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'junction');
      const repo = join(dir, 'repo');
      cpSync(join(ROOT, '__fixtures__', 'java'), repo, { recursive: true });

      const bin = join(copy, 'bin', 'provenlens.js');
      const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: repo, encoding: 'utf8' });
      assert.equal(run('--version').stdout.trim(), '0.1.0');
      const init = run('init', '.');
      assert.equal(init.status, 0, init.stderr);
      assert.match(init.stdout, /indexed \d+ file\(s\), \d+ symbol\(s\)/);
      assert.ok(existsSync(join(repo, '.provenlens')));
      assert.match(run('status').stdout, /resolution:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
