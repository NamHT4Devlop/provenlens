import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withoutOurHooks, withoutMcpEntry, hookEntries } from '../src/install.js';

// `install` knows exactly what it wrote, so `uninstall` must take back exactly
// that and nothing else. These run on objects, never on anybody's settings file.

const ours = () => hookEntries();
const theirs = { type: 'command', command: '/home/me/.claude/hooks/git-guard.sh', timeout: 10 };

describe('taking our hooks back out of settings.json', () => {
  test('removes ours and leaves a stranger\'s hook in the same event untouched', () => {
    const config = {
      theme: 'dark',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [theirs] }],
        PostToolUse: [...ours().PostToolUse],
        SessionStart: [...ours().SessionStart],
      },
    };
    const { config: out, removed } = withoutOurHooks(config);
    assert.equal(removed, 2);
    assert.deepEqual(out.hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [theirs] }] });
    assert.equal(out.theme, 'dark', 'unrelated settings survive');
    assert.deepEqual(config.hooks.PostToolUse, ours().PostToolUse, 'the input is not mutated');
  });

  test('keeps a group that mixes ours with somebody else\'s, minus ours', () => {
    const mixed = { matcher: 'Edit', hooks: [theirs, ...ours().PostToolUse[0].hooks] };
    const { config: out, removed } = withoutOurHooks({ hooks: { PostToolUse: [mixed] } });
    assert.equal(removed, 1);
    assert.deepEqual(out.hooks.PostToolUse, [{ matcher: 'Edit', hooks: [theirs] }]);
  });

  test('drops the hooks key entirely when ours were all there was', () => {
    const { config: out, removed } = withoutOurHooks({ hooks: { ...ours() }, model: 'sonnet' });
    assert.equal(removed, 2);
    assert.deepEqual(out, { model: 'sonnet' });
  });

  test('reports nothing to do when none of ours are present, and is idempotent', () => {
    const config = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [theirs] }] } };
    const first = withoutOurHooks(config);
    assert.equal(first.removed, 0);
    assert.deepEqual(first.config, config);
    const twice = withoutOurHooks(withoutOurHooks({ hooks: { ...ours() } }).config);
    assert.equal(twice.removed, 0);
  });

  test('recognises ours by the command, not by position or matcher', () => {
    // A user may have reordered or re-matched the entry; the bin running
    // `hook` is what makes it ours.
    const moved = { matcher: 'Write', hooks: [{ type: 'command', command: '"/elsewhere/provenlens/bin/provenlens.js" hook' }] };
    assert.equal(withoutOurHooks({ hooks: { PostToolUse: [moved] } }).removed, 1);
    const windows = { hooks: [{ type: 'command', command: 'node "C:\\p\\provenlens\\bin\\provenlens.js" hook' }] };
    assert.equal(withoutOurHooks({ hooks: { SessionStart: [windows] } }).removed, 1);
  });
});

describe('taking the MCP entry back out of an agent config', () => {
  test('removes only the provenlens server and keeps the others', () => {
    const config = { mcpServers: { provenlens: { command: 'x', args: ['mcp'] }, other: { command: 'y' } }, k: 1 };
    const { config: out, removed } = withoutMcpEntry(config, 'mcpServers');
    assert.equal(removed, true);
    assert.deepEqual(out, { mcpServers: { other: { command: 'y' } }, k: 1 });
    assert.ok(config.mcpServers.provenlens, 'the input is not mutated');
  });

  test('drops the mcpServers key when provenlens was the only server', () => {
    const { config: out } = withoutMcpEntry({ mcpServers: { provenlens: {} }, k: 1 }, 'mcpServers');
    assert.deepEqual(out, { k: 1 });
  });

  test('says so when there is nothing to remove', () => {
    for (const config of [{}, { mcpServers: {} }, { mcpServers: { other: {} } }]) {
      const { config: out, removed } = withoutMcpEntry(config, 'mcpServers');
      assert.equal(removed, false);
      assert.deepEqual(out, config);
    }
  });
});
