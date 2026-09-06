import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildIndex } from './helpers.js';
import { afterEdit, atSessionStart, runHook } from '../src/hook.js';
import { hookEntries } from '../src/install.js';

let db;
let root;

before(async () => {
  ({ db, root } = await buildIndex('java'));
});

describe('what the edit hook tells Claude', () => {
  test('names what an edited file reaches and the tests that already cover it', () => {
    // The point of the index is that an agent implementing a change knows
    // what the change reaches. A hook does the looking so the agent need not
    // remember to.
    const msg = afterEdit(db, root, join(root, 'com', 'acme', 'domain', 'Donation.java'));
    assert.ok(msg, 'an indexed file with symbols must produce a message');
    assert.match(msg, /Donation\.java: \d+ symbol\(s\) here reach \d+ symbol\(s\) in \d+ other file\(s\)/);
    assert.match(msg, /reached: /);
    assert.match(msg, /covered by/);
  });

  test('accepts the path as git prints it, not only as absolute', () => {
    const a = afterEdit(db, root, join(root, 'com', 'acme', 'domain', 'Donation.java'));
    const b = afterEdit(db, root, 'com/acme/domain/Donation.java');
    assert.ok(a, 'the absolute spelling must produce a message');
    assert.equal(a, b);
  });

  test('stays silent for a file the index does not know', () => {
    assert.equal(afterEdit(db, root, join(root, 'README.md')), null);
  });

  test('keeps the lists short enough to read in one glance', () => {
    const msg = afterEdit(db, root, 'com/acme/domain/Donation.java');
    assert.ok(msg, 'there must be a message to measure');
    for (const line of msg.split('\n')) {
      assert.ok(line.length < 400, `a line this long is a dump, not a hint: ${line.length} chars`);
    }
  });
});

describe('what the session hook tells Claude', () => {
  test('says the index is there, how big, how well resolved, and what to use', () => {
    const text = atSessionStart(db, root);
    assert.match(text, /provenlens index present at /);
    assert.match(text, /\d+ files, \d+ symbols, [\d.]+% of in-repo calls linked/);
    assert.match(text, /provenlens_explore/);
  });
});

describe('the hook as a process would run it', () => {
  const capture = () => {
    const buf = { out: '', err: '' };
    return { buf, out: { write: (s) => (buf.out += s) }, err: { write: (s) => (buf.err += s) } };
  };

  test('ignores events it has nothing to say about, with exit 0 and no output', async () => {
    for (const event of [null, {}, { hook_event_name: 'PreToolUse' }, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }]) {
      const { buf, out, err } = capture();
      assert.equal(await runHook(event, { out, err }), 0);
      assert.equal(buf.out + buf.err, '');
    }
  });

  test('is silent for an edit outside any indexed project', async () => {
    const { buf, out, err } = capture();
    const code = await runHook(
      { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/nowhere/at/all/x.js' } },
      { out, err },
    );
    assert.equal(code, 0);
    assert.equal(buf.out + buf.err, '');
  });
});

describe('the hook entries the installer writes', () => {
  test('use the documented channel for each event and name the bin absolutely', () => {
    const h = hookEntries();
    // PostToolUse output reaches Claude only through exit 2 + stderr, so the
    // hook must be attached to the file-editing tools and nothing else.
    assert.equal(h.PostToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
    assert.match(h.PostToolUse[0].hooks[0].command, /provenlens\.js" hook$/);
    // SessionStart has no matcher: it fires once, for any session.
    assert.equal(h.SessionStart[0].matcher, undefined);
    assert.match(h.SessionStart[0].hooks[0].command, /provenlens\.js" hook$/);
    for (const groups of Object.values(h)) {
      for (const g of groups) for (const hook of g.hooks) assert.ok(hook.timeout <= 30, 'a hook that hangs stalls every edit');
    }
  });
});
