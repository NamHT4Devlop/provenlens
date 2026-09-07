/**
 * What a machine other than the author's meets first.
 *
 * Two things went wrong there before anything else could: a Node between 22.5
 * and 22.12 failed to link `node:sqlite` with a message that named no version,
 * and an older Linux could not run the `#!/usr/bin/env -S` shebang the binary
 * used to carry `--no-warnings`. The binary now starts with the plain shebang,
 * silences the experimental notice itself, and says in one sentence which Node
 * it needs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sqliteAvailable, sqliteUnavailableMessage, NODE_REQUIREMENT } from '../src/db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BIN = join(ROOT, 'bin', 'provenlens.js');

describe('the binary on a plain node', () => {
  test('starts with a shebang every env understands', () => {
    for (const file of ['bin/provenlens.js', 'scripts/bench.js']) {
      const first = readFileSync(join(ROOT, file), 'utf8').split('\n')[0];
      assert.equal(first, '#!/usr/bin/env node', `${file}: ${first}`);
    }
  });

  test('prints nothing but the version when run without --no-warnings', () => {
    // No flags at all: this is what the symlink, `provenlens.cmd` and a bare
    // `node bin/provenlens.js` all do.
    const res = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '0.1.0');
    assert.equal(res.stderr, '', 'the experimental-feature notice must not reach the user');
  });
});

describe('the Node requirement', () => {
  test('this Node has sqlite, so the check passes', () => {
    assert.equal(sqliteAvailable(), true);
  });

  test('a Node without sqlite gets one sentence and exit 1, not a stack trace', () => {
    // The closest thing to Node 22.12 on a machine that has 22.13+: the
    // module switched off by the flag that used to switch it on.
    const res = spawnSync(process.execPath, ['--no-experimental-sqlite', BIN, '--version'], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 1);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /^provenlens needs Node\.js 22\.13 or newer: node:sqlite is not available in Node \d+\.\d+\.\d+\./);
    assert.doesNotMatch(res.stderr, /at .*\.js:\d+/, 'no stack trace');
  });

  test('the message names the version needed and the version found', () => {
    const msg = sqliteUnavailableMessage('22.12.0');
    assert.match(msg, /Node\.js 22\.13 or newer/);
    assert.match(msg, /Node 22\.12\.0/);
    assert.match(msg, /nvm install 22/);
  });

  test('package.json, README and SETUP agree with the check', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.engines.node, '>=22.13.0');
    assert.equal(NODE_REQUIREMENT, 'Node.js 22.13 or newer');
    for (const file of ['README.md', 'SETUP.md', 'SETUP.vi.md']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      // Booleans, not `assert.match`, so a failure names the file instead of
      // printing the whole document.
      assert.ok(/22\.13/.test(text), `${file} states the 22.13 floor`);
      assert.ok(!/Node(\.js)? 22 or newer|Node 22 trở lên/.test(text), `${file} still says plain 22`);
    }
  });
});
