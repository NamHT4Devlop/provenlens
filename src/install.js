/**
 * Registers the MCP server with agents that read a JSON config.
 *
 * Every write is shown before it happens and the previous file is kept as
 * .bak -- this edits config the user owns, so it should never be a surprise.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = resolve(fileURLToPath(import.meta.url), '..', '..', 'bin', 'provenlens.js');

export const TARGETS = {
  'claude-user': {
    label: 'Claude Code (user scope)',
    file: join(homedir(), '.claude.json'),
    key: 'mcpServers',
  },
  'claude-project': {
    label: 'Claude Code (this project)',
    file: join(process.cwd(), '.mcp.json'),
    key: 'mcpServers',
  },
  cursor: {
    label: 'Cursor',
    file: join(homedir(), '.cursor', 'mcp.json'),
    key: 'mcpServers',
  },
};

export function serverEntry() {
  // The bin has a `#!/usr/bin/env -S node` shebang and the executable bit, so it can be the
  // command itself. Writing process.execPath instead pinned the exact interpreter that happened
  // to be running the install -- under nvm that is a version-stamped path like
  // .../versions/node/v24.13.0/bin/node -- and the server then died the next time the user
  // switched Node versions, in a config file nobody would think to look at. The README already
  // gives this same warning about `npm link` for the CLI; the installer was doing it to itself.
  //
  // Windows has no shebang. An MCP host there hands `command` to CreateProcess, which cannot
  // run a `.js` file, so the interpreter has to be named -- and it is named as the bare word
  // `node`, resolved from PATH when the host starts the server, for the same reason the
  // shebang says `env node` rather than a path: nothing is pinned to today's install.
  if (process.platform === 'win32') return { command: 'node', args: [BIN, 'mcp'] };
  return { command: BIN, args: ['mcp'] };
}

/**
 * Keeps the previous file as .bak before it is rewritten. A plain copy that
 * tolerates absence, rather than existsSync followed by copyFileSync: between
 * the check and the copy the file can change, which is a race CodeQL flags
 * and, for a config the user owns, one worth not having.
 */
function keepBackup(file) {
  try {
    copyFileSync(file, `${file}.bak`);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Fix or move it, then retry.`);
  }
}

/**
 * @returns {{target: string, file: string, action: 'create'|'update'|'unchanged'}}
 */
export function planInstall(targetName) {
  const target = TARGETS[targetName];
  if (!target) throw new Error(`unknown target: ${targetName}`);

  const config = readJson(target.file);
  const existing = config[target.key]?.provenlens;
  const wanted = serverEntry();
  const same = JSON.stringify(existing) === JSON.stringify(wanted);

  return {
    target: targetName,
    label: target.label,
    file: target.file,
    action: !existsSync(target.file) ? 'create' : same ? 'unchanged' : 'update',
    entry: wanted,
  };
}

export function applyInstall(targetName) {
  const target = TARGETS[targetName];
  const plan = planInstall(targetName);
  if (plan.action === 'unchanged') return plan;

  const config = readJson(target.file);
  config[target.key] ??= {};
  config[target.key].provenlens = serverEntry();

  mkdirSync(dirname(target.file), { recursive: true });
  keepBackup(target.file);
  writeFileSync(target.file, `${JSON.stringify(config, null, 2)}\n`);
  return plan;
}

/**
 * The hook entries for Claude Code's settings.json. Absolute path to the bin,
 * for the same reason the MCP entry uses one: a hook runs from whatever
 * directory the agent is in, with whatever PATH the desktop app inherited.
 */
export function hookEntries() {
  const entry = serverEntry();
  const command = entry.command === 'node' ? `node "${entry.args[0]}" hook` : `"${entry.command}" hook`;
  return {
    // After every file edit: what it reaches and which tests cover it, shown
    // to Claude via exit 2 + stderr -- the documented channel for PostToolUse.
    PostToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command, timeout: 20, statusMessage: 'provenlens: blast radius' }],
      },
    ],
    // On a new session in an indexed repository: one paragraph saying the
    // index is there and how to use it, as context rather than as a notice.
    SessionStart: [
      { hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'provenlens' }] },
    ],
  };
}

const HOOK_SETTINGS = join(homedir(), '.claude', 'settings.json');

/** True when a hook array already carries one of ours. */
const hasOurs = (list) =>
  (list ?? []).some((group) => (group.hooks ?? []).some((h) => /provenlens(\.js)?"? hook$/.test(h.command ?? '')));

export function planHooks() {
  const config = readJson(HOOK_SETTINGS);
  const wanted = hookEntries();
  const missing = Object.keys(wanted).filter((event) => !hasOurs(config.hooks?.[event]));
  return {
    file: HOOK_SETTINGS,
    action: !existsSync(HOOK_SETTINGS) ? 'create' : missing.length ? 'update' : 'unchanged',
    events: missing,
    entries: wanted,
  };
}

/** Appends our hook groups to the events that lack one; touches nothing else. */
export function applyHooks() {
  const plan = planHooks();
  if (plan.action === 'unchanged') return plan;
  const config = readJson(HOOK_SETTINGS);
  config.hooks ??= {};
  for (const event of plan.events) {
    config.hooks[event] = [...(config.hooks[event] ?? []), ...plan.entries[event]];
  }
  mkdirSync(dirname(HOOK_SETTINGS), { recursive: true });
  keepBackup(HOOK_SETTINGS);
  writeFileSync(HOOK_SETTINGS, `${JSON.stringify(config, null, 2)}\n`);
  return plan;
}

/**
 * Targets to configure when none is named: only agents whose config file is
 * already there.
 *
 * A project-scoped target is deliberately never auto-detected. Its path is
 * whatever directory the command runs in, so detecting it would drop a .mcp.json
 * into an unrelated repository. Ask for it by name to get it.
 */
export function detectTargets() {
  return Object.entries(TARGETS)
    .filter(([name, t]) => !name.endsWith('-project') && existsSync(t.file))
    .map(([name]) => name);
}
